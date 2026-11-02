import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { AppError } from '../common/app-error';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';

export type SelectionCode = 'HOME' | 'DRAW' | 'AWAY' | '1X' | '12' | 'X2' | 'OVER' | 'UNDER' | 'YES' | 'NO';
export type MarketCode = 'MATCH' | 'DOUBLE' | 'GOALS' | 'BTTS';
export type BetStatus = 'OPEN' | 'WON' | 'LOST' | 'VOID';

export interface PlaceBetCommand {
  posId: string;
  selectionId: number;
  stake: number;
  /** Odds the cashier saw, in hundredths. If the market moved since, the bet is refused. */
  acceptedOdds: number;
  idempotencyKey: string;
}

interface BoardRow {
  event_id: number;
  sport: string;
  league: string;
  home: string;
  away: string;
  starts_at: Date;
  status: 'SCHEDULED' | 'LIVE' | 'FINISHED';
  minute: number;
  home_score: number;
  away_score: number;
  version: number;
  total_line: string;
  selection_id: number;
  market: MarketCode;
  code: SelectionCode;
  odds_x100: number;
  suspended: boolean;
}

interface BetRow {
  id: string;
  pos_id: string;
  selection_id: number;
  stake: number;
  odds_x100: number;
  potential_payout: number;
  status: BetStatus;
  request_hash: string;
  created_at: Date;
  settled_at: Date | null;
  market: MarketCode;
  code: SelectionCode;
  home: string;
  away: string;
  league: string;
  sport: string;
  total_line: string;
}

const SELECT_BET = `
  SELECT b.*, s.market, s.code, e.home, e.away, e.league, e.sport, e.total_line
  FROM bets b
  JOIN selections s ON s.id = b.selection_id
  JOIN sports_events e ON e.id = s.event_id
`;

export const toBet = (row: BetRow) => ({
  id: row.id,
  selectionId: row.selection_id,
  market: row.market,
  pick: row.code,
  match: `${row.home} vs ${row.away}`,
  league: row.league,
  sport: row.sport,
  totalLine: Number(row.total_line),
  stake: row.stake,
  odds: row.odds_x100 / 100,
  potentialPayout: row.potential_payout,
  status: row.status,
  createdAt: row.created_at,
  settledAt: row.settled_at,
});

export type Bet = ReturnType<typeof toBet>;

/** Payout in whole pesos, rounded down: the house never pays a fraction it does not owe. */
export const payoutFor = (stake: number, oddsX100: number) => Math.floor((stake * oddsX100) / 100);

export const winningCode = (home: number, away: number): SelectionCode => (home > away ? 'HOME' : home < away ? 'AWAY' : 'DRAW');

/** Every winning selection of a final score, as MARKET:CODE. The total market compares with the event's line. */
export function winningSelections(home: number, away: number, totalLine = 2.5): string[] {
  const result = winningCode(home, away);
  const doubles = { HOME: ['1X', '12'], DRAW: ['1X', 'X2'], AWAY: ['12', 'X2'] }[result as 'HOME' | 'DRAW' | 'AWAY'];
  return [
    `MATCH:${result}`,
    ...doubles.map((code) => `DOUBLE:${code}`),
    `GOALS:${home + away > totalLine ? 'OVER' : 'UNDER'}`,
    `BTTS:${home > 0 && away > 0 ? 'YES' : 'NO'}`,
  ];
}

@Injectable()
export class BettingService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Upcoming and live matches, plus the last finished ones, with the odds of every market. */
  async board() {
    const { rows } = await this.db.query<BoardRow>(
      `SELECT e.id AS event_id, e.sport, e.league, e.home, e.away, e.starts_at, e.status, e.minute,
              e.home_score, e.away_score, e.version, e.total_line, s.id AS selection_id, s.market, s.code, s.odds_x100, s.suspended
       FROM sports_events e JOIN selections s ON s.event_id = e.id
       WHERE e.status <> 'FINISHED' OR e.updated_at > now() - interval '10 minutes'
       ORDER BY CASE e.status WHEN 'LIVE' THEN 0 WHEN 'SCHEDULED' THEN 1 ELSE 2 END, e.starts_at, e.id,
                array_position(ARRAY['MATCH', 'DOUBLE', 'GOALS', 'BTTS'], s.market::text),
                array_position(ARRAY['HOME', 'DRAW', 'AWAY', '1X', '12', 'X2', 'OVER', 'UNDER', 'YES', 'NO'], s.code::text)`,
    );
    const eventView = (row: BoardRow) => ({
      id: row.event_id,
      sport: row.sport,
      league: row.league,
      home: row.home,
      away: row.away,
      startsAt: row.starts_at,
      status: row.status,
      minute: row.minute,
      score: [row.home_score, row.away_score] as [number, number],
      totalLine: Number(row.total_line),
      version: row.version,
      selections: [] as Array<{ id: number; market: MarketCode; code: SelectionCode; odds: number; suspended: boolean }>,
    });
    const events = new Map<number, ReturnType<typeof eventView>>();
    for (const row of rows) {
      if (!events.has(row.event_id)) events.set(row.event_id, eventView(row));
      events.get(row.event_id)!.selections.push({
        id: row.selection_id,
        market: row.market,
        code: row.code,
        odds: row.odds_x100 / 100,
        suspended: row.suspended || row.status === 'FINISHED',
      });
    }
    return [...events.values()];
  }

  /**
   * One short transaction, like a top-up sale: idempotency check, odds check, atomic debit,
   * OPEN bet and its ledger entry. A replay returns the first bet; changed data is a 409.
   */
  async placeBet(command: PlaceBetCommand): Promise<{ bet: Bet; replayed: boolean }> {
    if (command.stake < this.config.BET_MIN_STAKE || command.stake > this.config.BET_MAX_STAKE) {
      throw new AppError(400, 'STAKE_OUT_OF_RANGE', 'Stake is outside the allowed range', {
        min: this.config.BET_MIN_STAKE,
        max: this.config.BET_MAX_STAKE,
      });
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify([command.selectionId, command.stake, command.acceptedOdds]))
      .digest('hex');

    return this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${command.posId}:bet:${command.idempotencyKey}`,
      ]);
      const existing = await client.query<BetRow>(`${SELECT_BET} WHERE b.pos_id = $1 AND b.idempotency_key = $2`, [
        command.posId,
        command.idempotencyKey,
      ]);
      if (existing.rows.length > 0) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with different data');
        }
        return { bet: toBet(existing.rows[0]), replayed: true };
      }

      // FOR SHARE: the odds feed must wait until this bet commits before it can move this price.
      const market = await client.query<{ odds_x100: number; suspended: boolean; status: string }>(
        `SELECT s.odds_x100, s.suspended, e.status
         FROM selections s JOIN sports_events e ON e.id = s.event_id
         WHERE s.id = $1
         FOR SHARE OF s`,
        [command.selectionId],
      );
      if (market.rows.length === 0) {
        throw new AppError(404, 'SELECTION_NOT_FOUND', 'Selection not found');
      }
      const { odds_x100: odds, suspended, status } = market.rows[0];
      if (status === 'FINISHED') {
        throw new AppError(409, 'EVENT_CLOSED', 'The event has finished');
      }
      if (suspended) {
        throw new AppError(409, 'MARKET_SUSPENDED', 'Betting on this market is suspended');
      }
      if (odds !== command.acceptedOdds) {
        // No money moves: the cashier confirms the new price and retries with a new key.
        throw new AppError(409, 'ODDS_CHANGED', 'The odds changed; confirm the new price', { currentOdds: odds });
      }

      const debit = await client.query<{ balance: number }>(
        `UPDATE points_of_sale SET balance = balance - $1, updated_at = now()
         WHERE id = $2 AND active AND balance >= $1
         RETURNING balance`,
        [command.stake, command.posId],
      );
      if (debit.rows.length === 0) {
        await this.throwInsufficient(client, command.posId, command.stake);
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bets (pos_id, selection_id, stake, odds_x100, potential_payout, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [command.posId, command.selectionId, command.stake, odds, payoutFor(command.stake, odds), command.idempotencyKey, requestHash],
      );
      await client.query(
        `INSERT INTO balance_movements (pos_id, type, amount, balance_after, bet_id) VALUES ($1, 'BET', $2, $3, $4)`,
        [command.posId, -command.stake, debit.rows[0].balance, inserted.rows[0].id],
      );
      const bet = await client.query<BetRow>(`${SELECT_BET} WHERE b.id = $1`, [inserted.rows[0].id]);
      return { bet: toBet(bet.rows[0]), replayed: false };
    });
  }

  async listBets(posId: string) {
    const { rows } = await this.db.query<BetRow>(`${SELECT_BET} WHERE b.pos_id = $1 ORDER BY b.created_at DESC LIMIT 50`, [
      posId,
    ]);
    return rows.map(toBet);
  }

  /**
   * Settles every OPEN bet of a finished event. Safe to run more than once: only OPEN bets are
   * updated, and a unique index allows one payout per bet.
   */
  async settleEvent(eventId: number): Promise<{ won: number; lost: number }> {
    return this.db.transaction(async (client) => {
      const event = await client.query<{ status: string; home_score: number; away_score: number; total_line: string }>(
        'SELECT status, home_score, away_score, total_line FROM sports_events WHERE id = $1 FOR UPDATE',
        [eventId],
      );
      if (event.rows.length === 0) {
        throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');
      }
      const { status, home_score: home, away_score: away, total_line: totalLine } = event.rows[0];
      if (status !== 'FINISHED') {
        throw new AppError(409, 'EVENT_NOT_FINISHED', 'Only finished events can be settled');
      }

      const settled = await client.query<{ id: string; pos_id: string; potential_payout: number; status: BetStatus }>(
        `UPDATE bets b
         SET status = CASE WHEN s.market || ':' || s.code = ANY($2::text[]) THEN 'WON' ELSE 'LOST' END, settled_at = now()
         FROM selections s
         WHERE b.selection_id = s.id AND s.event_id = $1 AND b.status = 'OPEN'
         RETURNING b.id, b.pos_id, b.potential_payout, b.status`,
        [eventId, winningSelections(home, away, Number(totalLine))],
      );

      // Credit winners in a fixed order of stores, so two settlements never deadlock on balances.
      const winners = settled.rows.filter((bet) => bet.status === 'WON').sort((a, b) => a.pos_id.localeCompare(b.pos_id));
      for (const bet of winners) {
        const credit = await client.query<{ balance: number }>(
          'UPDATE points_of_sale SET balance = balance + $1, updated_at = now() WHERE id = $2 RETURNING balance',
          [bet.potential_payout, bet.pos_id],
        );
        await client.query(
          `INSERT INTO balance_movements (pos_id, type, amount, balance_after, bet_id) VALUES ($1, 'BET_PAYOUT', $2, $3, $4)`,
          [bet.pos_id, bet.potential_payout, credit.rows[0].balance, bet.id],
        );
      }
      return { won: winners.length, lost: settled.rows.length - winners.length };
    });
  }

  private async throwInsufficient(client: PoolClient, posId: string, amount: number): Promise<never> {
    const { rows } = await client.query<{ balance: number }>('SELECT balance FROM points_of_sale WHERE id = $1 AND active', [posId]);
    if (rows.length === 0) {
      throw new AppError(404, 'POS_NOT_FOUND', 'Point of sale not found or inactive');
    }
    throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Not enough prepaid balance', { balance: rows[0].balance, amount });
  }
}
