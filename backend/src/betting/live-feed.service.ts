import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { BettingService } from './betting.service';

export type Sport = 'FUTBOL' | 'BALONCESTO' | 'BEISBOL' | 'HOCKEY';
export type Market = 'MATCH' | 'DOUBLE' | 'GOALS' | 'BTTS';

interface SportModel {
  /** Regulation length in clock units: minutes, or outs in baseball (9 innings x 6 outs). */
  length: number;
  /** Clock units of each extra period played while the score is level; 0 means a draw stands. */
  extra: number;
  /** Expected score per clock unit for each side. */
  rate: { home: number; away: number };
  /** Line of the total market: goals, points or runs. */
  line: number;
  markets: Market[];
}

export const SPORTS: Record<Sport, SportModel> = {
  // About 1.4 and 1.1 goals per team over 90 minutes, like real football.
  FUTBOL: { length: 90, extra: 0, rate: { home: 0.0155, away: 0.0122 }, line: 2.5, markets: ['MATCH', 'DOUBLE', 'GOALS', 'BTTS'] },
  // About 3.1 and 2.7 goals per team over 60 minutes; a regulation draw stands for betting.
  HOCKEY: { length: 60, extra: 0, rate: { home: 0.052, away: 0.045 }, line: 5.5, markets: ['MATCH', 'DOUBLE', 'GOALS', 'BTTS'] },
  // About 111 and 107 points over 48 minutes, with 5-minute overtimes until someone leads.
  BALONCESTO: { length: 48, extra: 5, rate: { home: 2.32, away: 2.23 }, line: 217.5, markets: ['MATCH', 'GOALS'] },
  // About 4.6 and 4.3 runs per team over 54 outs, with extra innings until someone leads.
  BEISBOL: { length: 54, extra: 6, rate: { home: 0.085, away: 0.08 }, line: 8.5, markets: ['MATCH', 'GOALS'] },
};

// Fictitious clubs and leagues: no real team, league or brand appears in the demo.
const FIXTURES: Array<[Sport, string, string, string]> = [
  ['FUTBOL', 'Liga Demo Colombia', 'Atlético Andino', 'Deportivo Caribe'],
  ['BALONCESTO', 'Liga Demo de Baloncesto', 'Cóndores de Altura', 'Tiburones del Pacífico'],
  ['FUTBOL', 'Liga Demo Colombia', 'Real Cordillera', 'Unión Pacífico'],
  ['BEISBOL', 'Liga Demo de Béisbol', 'Lagartos de la Ciénaga', 'Pelícanos del Golfo'],
  ['FUTBOL', 'Copa Demo Sudamericana', 'Independiente Sabana', 'Club Río Magdalena'],
  ['HOCKEY', 'Liga Demo de Hockey', 'Osos del Norte', 'Linces de la Montaña'],
  ['FUTBOL', 'Liga Demo Colombia', 'Juventud Llanera', 'Sporting Altiplano'],
  ['BALONCESTO', 'Liga Demo de Baloncesto', 'Halcones Urbanos', 'Gigantes del Valle'],
  ['FUTBOL', 'Copa Demo Sudamericana', 'Estrella del Sur', 'Racing Montaña'],
  ['BEISBOL', 'Liga Demo de Béisbol', 'Delfines de Arena', 'Truenos del Llano'],
  ['FUTBOL', 'Liga Demo Colombia', 'Corsarios del Golfo', 'Halcones de la Sierra'],
  ['HOCKEY', 'Liga Demo de Hockey', 'Glaciares Unidos', 'Lobos del Páramo'],
  ['FUTBOL', 'Copa Demo Sudamericana', 'Cóndores del Norte', 'Deportivo Valle Verde'],
  ['FUTBOL', 'Liga Demo Colombia', 'Atlético Bahía', 'Unión Cafetera'],
];
const BOARD_SIZE = 10; // events that are live or about to start
const MARGIN = 1.06; // bookmaker margin over fair probabilities
const MINUTES_PER_TICK = 1; // one clock unit per tick (3 s by default)
const MAX_CLOCK = 115; // the column allows 120; a game still level here is decided by its last play
const FEED_LOCK = 'betting-live-feed';

/**
 * Fair 1X2 probabilities in football from the score difference and the share of the match still to play
 * (1 at kickoff, 0 at full time). A level match drifts toward a draw; a lead makes a comeback less likely.
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

const poissonPmf = (k: number, mean: number) => {
  let p = Math.exp(-mean);
  for (let i = 1; i <= k; i += 1) p *= mean / i;
  return p;
};

const poissonAtLeast = (goals: number, mean: number) => {
  let below = 0;
  for (let k = 0; k < goals; k += 1) below += poissonPmf(k, mean);
  return Math.max(0, 1 - below);
};

// Abramowitz and Stegun 7.1.26, accurate to about 1e-7: enough for prices with two decimals.
const normalCdf = (x: number) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
};

/** HOME, DRAW and AWAY at the end of play, adding Poisson-distributed goals or runs to the current score. */
function poissonResult(diff: number, homeMean: number, awayMean: number): [number, number, number] {
  let win = 0;
  let draw = 0;
  let total = 0;
  for (let i = 0; i <= 15; i += 1) {
    for (let j = 0; j <= 15; j += 1) {
      const p = poissonPmf(i, homeMean) * poissonPmf(j, awayMean);
      total += p;
      if (diff + i - j > 0) win += p;
      else if (diff + i - j === 0) draw += p;
    }
  }
  return [win / total, draw / total, (total - win - draw) / total];
}

/** Clock units left in regulation, or in the current extra period once regulation is over. */
const unitsLeft = (model: SportModel, minute: number) =>
  minute < model.length ? model.length - minute : model.extra === 0 ? 0 : model.extra - ((minute - model.length) % model.extra);

/** True when the game is over: regulation ends level only where a draw stands; extra periods end only with a leader. */
export function isFinished(sport: Sport, minute: number, home: number, away: number): boolean {
  const model = SPORTS[sport];
  if (minute >= MAX_CLOCK) return true;
  if (minute < model.length) return false;
  if (model.extra === 0) return true;
  return home !== away && (minute - model.length) % model.extra === 0;
}

/**
 * Fair probabilities for every market of an event. Football keeps its calibrated 1X2 curve; hockey and
 * baseball add Poisson goals or runs over the time left; basketball, with many points, uses a normal
 * approximation. Totals use the same distributions, and two-way sports split a likely tie by strength.
 */
export function marketProbabilities(sport: Sport, home: number, away: number, minute: number): Array<[Market, string, number]> {
  const model = SPORTS[sport];
  const left = unitsLeft(model, minute);
  const homeMean = model.rate.home * left;
  const awayMean = model.rate.away * left;
  const spread = Math.sqrt((homeMean + awayMean) * 2.4); // basketball points arrive in twos and threes

  let result: [number, number, number];
  if (sport === 'FUTBOL') {
    result = matchProbabilities(home - away, left / model.length);
  } else if (sport === 'BALONCESTO') {
    const homeWins = spread === 0 ? (home > away ? 1 : home < away ? 0 : 0.5) : normalCdf((home - away + homeMean - awayMean) / spread);
    result = [homeWins, 0, 1 - homeWins];
  } else {
    result = poissonResult(home - away, homeMean, awayMean);
  }
  if (model.extra > 0 && result[1] > 0) {
    const share = model.rate.home / (model.rate.home + model.rate.away);
    result = [result[0] + result[1] * share, 0, result[2] + result[1] * (1 - share)];
  }
  const [win, draw, loss] = result;

  const total = home + away;
  // Scores only go up: once the total passes the line, the over is certain.
  const over =
    total > model.line
      ? 1
      : sport === 'BALONCESTO'
        ? spread === 0
          ? 0
          : 1 - normalCdf((model.line - total - homeMean - awayMean) / spread)
        : poissonAtLeast(Math.ceil(model.line) - total, homeMean + awayMean);
  const both = (home > 0 ? 1 : 1 - Math.exp(-homeMean)) * (away > 0 ? 1 : 1 - Math.exp(-awayMean));

  const prices: Array<[Market, string, number]> = [];
  for (const market of model.markets) {
    if (market === 'MATCH') {
      prices.push(['MATCH', 'HOME', win]);
      if (model.extra === 0) prices.push(['MATCH', 'DRAW', draw]);
      prices.push(['MATCH', 'AWAY', loss]);
    } else if (market === 'DOUBLE') {
      prices.push(['DOUBLE', '1X', win + draw], ['DOUBLE', '12', win + loss], ['DOUBLE', 'X2', draw + loss]);
    } else if (market === 'GOALS') {
      prices.push(['GOALS', 'OVER', over], ['GOALS', 'UNDER', 1 - over]);
    } else {
      prices.push(['BTTS', 'YES', both], ['BTTS', 'NO', 1 - both]);
    }
  }
  return prices;
}

/** A totals or both-teams market is decided once the score makes one outcome certain; it is suspended, not priced at 1.00. */
const decided = (market: Market, probability: number) => (market === 'GOALS' || market === 'BTTS') && (probability < 0.005 || probability > 0.995);

export function oddsFromProbability(probability: number): number {
  return Math.min(5000, Math.max(101, Math.round(100 / (probability * MARGIN))));
}

/** Score added in one clock unit: a single goal or run at low rates, a Poisson draw of points in basketball. */
function scored(rate: number, random: () => number): number {
  if (rate < 0.5) return random() < rate ? 1 : 0;
  const u = random();
  let k = 0;
  let p = Math.exp(-rate);
  let cdf = p;
  while (u > cdf && k < 12) {
    k += 1;
    p *= rate / k;
    cdf += p;
  }
  return k;
}

/**
 * Simulates the provider's live odds feed: games start, the clock runs, teams score and prices move.
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
      const live = await client.query<{ id: number; sport: Sport; minute: number; home_score: number; away_score: number }>(
        "SELECT id, sport, minute, home_score, away_score FROM sports_events WHERE status = 'LIVE' ORDER BY id FOR UPDATE",
      );
      const done: number[] = [];
      for (const event of live.rows) {
        const model = SPORTS[event.sport];
        const minute = Math.min(120, event.minute + MINUTES_PER_TICK);
        let home = event.home_score + scored(model.rate.home * MINUTES_PER_TICK, random);
        const away = event.away_score + scored(model.rate.away * MINUTES_PER_TICK, random);
        const over = isFinished(event.sport, minute, home, away);
        if (over && home === away && model.extra > 0) home += 1; // still level at the clock limit
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
        for (const [market, code, probability] of marketProbabilities(event.sport, home, away, minute)) {
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

  /** Keeps BOARD_SIZE events that are live or about to start, staggered a few seconds apart. */
  private async keepBoardFull(client: PoolClient) {
    const { rows } = await client.query<{ open: number }>("SELECT count(*)::int AS open FROM sports_events WHERE status <> 'FINISHED'");
    for (let i = rows[0].open; i < BOARD_SIZE; i += 1) {
      const [sport, league, home, away] = FIXTURES[this.fixtureIndex % FIXTURES.length];
      this.fixtureIndex += 1;
      const event = await client.query<{ id: number }>(
        `INSERT INTO sports_events (sport, league, home, away, starts_at, total_line)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6) RETURNING id`,
        [sport, league, home, away, i * 15, SPORTS[sport].line],
      );
      for (const [market, code, probability] of marketProbabilities(sport, 0, 0, 0)) {
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
