import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { BettingService } from './betting.service';

// Fictitious clubs and leagues: no real team, league or brand appears in the demo.
const FIXTURES: Array<[string, string, string]> = [
  ['Liga Demo Colombia', 'Atlético Andino', 'Deportivo Caribe'],
  ['Liga Demo Colombia', 'Real Cordillera', 'Unión Pacífico'],
  ['Copa Demo Sudamericana', 'Independiente Sabana', 'Club Río Magdalena'],
  ['Liga Demo Colombia', 'Juventud Llanera', 'Sporting Altiplano'],
  ['Copa Demo Sudamericana', 'Estrella del Sur', 'Racing Montaña'],
  ['Liga Demo Colombia', 'Corsarios del Golfo', 'Halcones de la Sierra'],
  ['Copa Demo Sudamericana', 'Cóndores del Norte', 'Deportivo Valle Verde'],
  ['Liga Demo Colombia', 'Atlético Bahía', 'Unión Cafetera'],
];
const BOARD_SIZE = 6; // matches that are live or about to start
const MARGIN = 1.06; // bookmaker margin over fair probabilities
const MINUTES_PER_TICK = 1; // a 90-minute match lasts 90 ticks (4.5 min at the default 3 s interval)
// Goals per minute, about 1.4 for the home side and 1.1 for the away side over 90 minutes, like real football.
const GOAL_RATE = { home: 0.0155, away: 0.0122 };
const FEED_LOCK = 'betting-live-feed';

/**
 * Fair 1X2 probabilities from the score difference and the share of the match still to play (1 at kickoff,
 * 0 at full time). A level match drifts toward a draw; a lead makes a comeback less likely as time runs out.
 */
export function matchProbabilities(diff: number, remaining: number): [number, number, number] {
  if (diff === 0) {
    // Quadratic: a level match is still open at half time and becomes a likely draw only near the end.
    const draw = 0.27 + 0.68 * (1 - remaining) ** 2;
    return [(1 - draw) * 0.58, draw, (1 - draw) * 0.42];
  }
  // Chances of an equalizer and of a full comeback shrink with the lead and with the time left.
  const lead = Math.min(Math.abs(diff), 3);
  const [drawBase, drawPower, backBase, backPower] = [
    [0.45, 0.8, 0.22, 1.2],
    [0.18, 0.9, 0.06, 1.2],
    [0.05, 1, 0.015, 1],
  ][lead - 1];
  const draw = Math.max(0.01, drawBase * remaining ** drawPower);
  const comeback = Math.max(0.005, backBase * remaining ** backPower);
  const leader = 1 - draw - comeback;
  return diff > 0 ? [leader, draw, comeback] : [comeback, draw, leader];
}

const poissonAtLeast = (goals: number, mean: number) => {
  let below = 0;
  for (let k = 0, term = Math.exp(-mean); k < goals; k += 1, term *= mean / k) below += term;
  return 1 - below;
};

export type Market = 'MATCH' | 'DOUBLE' | 'GOALS' | 'BTTS';

/**
 * Fair probabilities for every market of a match. The match result uses matchProbabilities; total goals
 * and both-teams-to-score use the same goal rates as the simulation (Poisson over the minutes left);
 * double chance adds up the match-result outcomes.
 */
export function marketProbabilities(home: number, away: number, minute: number): Array<[Market, string, number]> {
  const [win, draw, loss] = matchProbabilities(home - away, (90 - minute) / 90);
  const left = 90 - minute;
  const over = poissonAtLeast(Math.max(0, 3 - home - away), (GOAL_RATE.home + GOAL_RATE.away) * left);
  const homeScores = home > 0 ? 1 : 1 - Math.exp(-GOAL_RATE.home * left);
  const awayScores = away > 0 ? 1 : 1 - Math.exp(-GOAL_RATE.away * left);
  const both = homeScores * awayScores;
  return [
    ['MATCH', 'HOME', win],
    ['MATCH', 'DRAW', draw],
    ['MATCH', 'AWAY', loss],
    ['DOUBLE', '1X', win + draw],
    ['DOUBLE', '12', win + loss],
    ['DOUBLE', 'X2', draw + loss],
    ['GOALS', 'OVER', over],
    ['GOALS', 'UNDER', 1 - over],
    ['BTTS', 'YES', both],
    ['BTTS', 'NO', 1 - both],
  ];
}

/** A goals market is decided once the score makes one outcome certain; it is suspended, not priced at 1.00. */
const decided = (market: Market, probability: number) => market !== 'MATCH' && market !== 'DOUBLE' && (probability < 0.005 || probability > 0.995);

export function oddsFromProbability(probability: number): number {
  return Math.min(5000, Math.max(101, Math.round(100 / (probability * MARGIN))));
}

/**
 * Simulates the provider's live odds feed: matches start, minutes pass, goals happen and prices move.
 * Several API replicas may run; each tick takes a transaction-level advisory lock, so only one moves the board.
 */
@Injectable()
export class LiveFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveFeedService.name);
  private timer?: NodeJS.Timeout;
  private fixtureIndex = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly betting: BettingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (!this.config.BETTING_FEED_ENABLED) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: Error) => this.logger.warn(`odds feed tick failed: ${error.message}`));
    }, this.config.BETTING_FEED_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** One step of the simulation. Returns the events that finished in this step (already settled). */
  async tick(random: () => number = Math.random): Promise<number[]> {
    const finished = await this.db.transaction(async (client) => {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [FEED_LOCK]);
      if (!rows[0].locked) return [];

      await this.keepBoardFull(client);
      await client.query(
        `UPDATE sports_events SET status = 'LIVE', version = version + 1, updated_at = now()
         WHERE status = 'SCHEDULED' AND starts_at <= now()`,
      );
      const live = await client.query<{ id: number; minute: number; home_score: number; away_score: number }>(
        "SELECT id, minute, home_score, away_score FROM sports_events WHERE status = 'LIVE' ORDER BY id FOR UPDATE",
      );
      const done: number[] = [];
      for (const event of live.rows) {
        const minute = Math.min(90, event.minute + MINUTES_PER_TICK);
        const home = event.home_score + (random() < GOAL_RATE.home * MINUTES_PER_TICK ? 1 : 0);
        const away = event.away_score + (random() < GOAL_RATE.away * MINUTES_PER_TICK ? 1 : 0);
        const over = minute >= 90;
        await client.query(
          `UPDATE sports_events SET minute = $2, home_score = $3, away_score = $4,
                  status = CASE WHEN $5 THEN 'FINISHED' ELSE status END, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [event.id, minute, home, away, over],
        );
        if (over) {
          await client.query('UPDATE selections SET suspended = TRUE WHERE event_id = $1', [event.id]);
          done.push(event.id);
          continue;
        }
        for (const [market, code, probability] of marketProbabilities(home, away, minute)) {
          const jitter = 1 + (random() - 0.5) * 0.04;
          await client.query('UPDATE selections SET odds_x100 = $4, suspended = $5 WHERE event_id = $1 AND market = $2 AND code = $3', [
            event.id,
            market,
            code,
            oddsFromProbability(probability * jitter),
            decided(market, probability),
          ]);
        }
      }
      return done;
    });

    // Settlement runs after the feed's commit, in its own transaction, so it sees the final score.
    for (const eventId of finished) {
      await this.betting.settleEvent(eventId);
    }
    return finished;
  }

  /** Keeps BOARD_SIZE matches that are live or about to start, staggered a few seconds apart. */
  private async keepBoardFull(client: PoolClient) {
    const { rows } = await client.query<{ open: number }>("SELECT count(*)::int AS open FROM sports_events WHERE status <> 'FINISHED'");
    for (let i = rows[0].open; i < BOARD_SIZE; i += 1) {
      const [league, home, away] = FIXTURES[this.fixtureIndex % FIXTURES.length];
      this.fixtureIndex += 1;
      const event = await client.query<{ id: number }>(
        `INSERT INTO sports_events (sport, league, home, away, starts_at)
         VALUES ('FUTBOL', $1, $2, $3, now() + make_interval(secs => $4)) RETURNING id`,
        [league, home, away, i * 15],
      );
      for (const [market, code, probability] of marketProbabilities(0, 0, 0)) {
        await client.query('INSERT INTO selections (event_id, market, code, odds_x100) VALUES ($1, $2, $3, $4)', [
          event.rows[0].id,
          market,
          code,
          oddsFromProbability(probability),
        ]);
      }
    }
  }
}
