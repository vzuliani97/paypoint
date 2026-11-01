import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { AppError } from '../common/app-error';
import { DatabaseService } from '../database/database.service';

export interface WalletOperation {
  posId: string;
  providerTxId: string;
  roundId: string;
  gameCode: string;
  amount: number;
}

export interface RollbackOperation {
  posId: string;
  providerTxId: string;
  rollsBackTxId: string;
  roundId: string;
  gameCode: string;
}

export interface WalletResult {
  providerTxId: string;
  status: 'APPLIED' | 'ALREADY_APPLIED' | 'ROLLBACK_RECORDED';
  balance: number;
}

/** Fictitious games. Outcome tables are part of the simulated provider, not of the wallet. */
export const GAMES = [
  { code: 'RULETA_ANDINA', name: 'Ruleta Andina', kind: 'Ruleta', minStake: 1000, maxStake: 200000, table: [[18, 2], [19, 0]] },
  { code: 'TRAGAMONEDAS_CAFE', name: 'Tragamonedas del Café', kind: 'Tragamonedas', minStake: 500, maxStake: 50000, table: [[2, 20], [6, 5], [12, 2], [20, 1], [60, 0]] },
  { code: 'ESMERALDAS_DEL_RIO', name: 'Esmeraldas del Río', kind: 'Tragamonedas', minStake: 500, maxStake: 50000, table: [[1, 50], [4, 10], [10, 3], [20, 1], [65, 0]] },
  { code: 'FRUTAS_TROPICALES', name: 'Frutas Tropicales', kind: 'Tragamonedas', minStake: 200, maxStake: 20000, table: [[3, 10], [10, 4], [15, 2], [22, 1], [50, 0]] },
  { code: 'BLACKJACK_PACIFICO', name: 'Blackjack Pacífico', kind: 'Blackjack', minStake: 2000, maxStake: 300000, table: [[44, 2], [8, 1], [48, 0]] },
] as const;

type Game = (typeof GAMES)[number];

/** Deterministic outcome from the round id: a replayed round always gets the same result. */
export function multiplierFor(game: Game, roundId: string): number {
  const weights = game.table.reduce((sum, [weight]) => sum + weight, 0);
  let roll = parseInt(createHash('sha256').update(roundId).digest('hex').slice(0, 8), 16) % weights;
  for (const [weight, multiplier] of game.table) {
    if (roll < weight) return multiplier;
    roll -= weight;
  }
  return 0;
}

/**
 * Seamless wallet for the casino provider: the provider debits the stake and credits the win with its own
 * transaction ids. Each id is applied once, whatever the provider retries, and a rollback that overtakes
 * its debit leaves a tombstone so the late debit is refused.
 */
@Injectable()
export class CasinoService {
  constructor(private readonly db: DatabaseService) {}

  games() {
    // The outcome table stays with the provider; the lobby only needs the top prize.
    return GAMES.map(({ table, ...game }) => ({ ...game, topMultiplier: Math.max(...table.map(([, multiplier]) => multiplier)) }));
  }

  debit(op: WalletOperation): Promise<WalletResult> {
    return this.db.transaction(async (client) => {
      const replay = await this.lockAndFind(client, op.posId, op.providerTxId, 'DEBIT');
      if (replay) return replay;

      const tombstone = await client.query('SELECT 1 FROM casino_transactions WHERE rolls_back_tx_id = $1', [op.providerTxId]);
      if (tombstone.rows.length > 0) {
        throw new AppError(409, 'ALREADY_ROLLED_BACK', 'This debit was already rolled back by the provider');
      }
      const balance = await client.query<{ balance: number }>(
        `UPDATE points_of_sale SET balance = balance - $1, updated_at = now()
         WHERE id = $2 AND active AND balance >= $1 RETURNING balance`,
        [op.amount, op.posId],
      );
      if (balance.rows.length === 0) {
        throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Not enough prepaid balance');
      }
      await this.record(client, op, 'DEBIT', null, -op.amount, balance.rows[0].balance);
      return { providerTxId: op.providerTxId, status: 'APPLIED' as const, balance: balance.rows[0].balance };
    });
  }

  credit(op: WalletOperation): Promise<WalletResult> {
    return this.db.transaction(async (client) => {
      const replay = await this.lockAndFind(client, op.posId, op.providerTxId, 'CREDIT');
      if (replay) return replay;

      // A win must belong to a round whose stake was taken.
      const round = await client.query(
        "SELECT 1 FROM casino_transactions WHERE pos_id = $1 AND round_id = $2 AND type = 'DEBIT'",
        [op.posId, op.roundId],
      );
      if (round.rows.length === 0) {
        throw new AppError(409, 'ROUND_NOT_FOUND', 'No debit exists for this round');
      }
      const balance = await client.query<{ balance: number }>(
        'UPDATE points_of_sale SET balance = balance + $1, updated_at = now() WHERE id = $2 RETURNING balance',
        [op.amount, op.posId],
      );
      await this.record(client, op, 'CREDIT', null, op.amount, balance.rows[0].balance);
      return { providerTxId: op.providerTxId, status: 'APPLIED' as const, balance: balance.rows[0].balance };
    });
  }

  rollback(op: RollbackOperation): Promise<WalletResult> {
    return this.db.transaction(async (client) => {
      const replay = await this.lockAndFind(client, op.posId, op.providerTxId, 'ROLLBACK');
      if (replay) return replay;
      // Serialize with the debit it cancels, so they cannot interleave.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`casino:${op.rollsBackTxId}`]);

      const debit = await client.query<{ amount: number }>(
        "SELECT amount FROM casino_transactions WHERE provider_tx_id = $1 AND type = 'DEBIT' AND pos_id = $2",
        [op.rollsBackTxId, op.posId],
      );
      if (debit.rows.length === 0) {
        // The debit never arrived (or has not yet): record a tombstone and move no money.
        await this.record(client, { ...op, amount: 0 }, 'ROLLBACK', op.rollsBackTxId, 0, await this.balanceOf(client, op.posId));
        return { providerTxId: op.providerTxId, status: 'ROLLBACK_RECORDED' as const, balance: await this.balanceOf(client, op.posId) };
      }
      const amount = debit.rows[0].amount;
      const balance = await client.query<{ balance: number }>(
        'UPDATE points_of_sale SET balance = balance + $1, updated_at = now() WHERE id = $2 RETURNING balance',
        [amount, op.posId],
      );
      await this.record(client, { ...op, amount }, 'ROLLBACK', op.rollsBackTxId, amount, balance.rows[0].balance);
      return { providerTxId: op.providerTxId, status: 'APPLIED' as const, balance: balance.rows[0].balance };
    });
  }

  /**
   * A cashier plays one round through the simulated provider. The round id comes from the store and the
   * Idempotency-Key, so a retry replays the same debit and credit instead of playing again.
   */
  async playRound(posId: string, gameCode: string, stake: number, idempotencyKey: string) {
    const game = GAMES.find((candidate) => candidate.code === gameCode);
    if (!game) throw new AppError(404, 'GAME_NOT_FOUND', 'Game not found');
    if (stake < game.minStake || stake > game.maxStake) {
      throw new AppError(400, 'STAKE_OUT_OF_RANGE', 'Stake is outside the table limits', { min: game.minStake, max: game.maxStake });
    }
    const roundId = createHash('sha256').update(`${posId}:${idempotencyKey}`).digest('hex').slice(0, 24);
    const debit = await this.debit({ posId, providerTxId: `${roundId}:debit`, roundId, gameCode, amount: stake });
    const multiplier = multiplierFor(game, roundId);
    const win = stake * multiplier;
    const credit = await this.credit({ posId, providerTxId: `${roundId}:credit`, roundId, gameCode, amount: win });
    return {
      roundId,
      game: game.name,
      stake,
      multiplier,
      win,
      balance: credit.balance,
      replayed: debit.status === 'ALREADY_APPLIED',
    };
  }

  private async lockAndFind(client: PoolClient, posId: string, providerTxId: string, type: string): Promise<WalletResult | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`casino:${providerTxId}`]);
    const existing = await client.query<{ type: string; pos_id: string }>(
      'SELECT type, pos_id FROM casino_transactions WHERE provider_tx_id = $1',
      [providerTxId],
    );
    if (existing.rows.length === 0) return null;
    if (existing.rows[0].type !== type || existing.rows[0].pos_id !== posId) {
      throw new AppError(409, 'TRANSACTION_ID_REUSED', 'This provider transaction id was used for a different operation');
    }
    return { providerTxId, status: 'ALREADY_APPLIED', balance: await this.balanceOf(client, posId) };
  }

  private async balanceOf(client: PoolClient, posId: string): Promise<number> {
    const { rows } = await client.query<{ balance: number }>('SELECT balance FROM points_of_sale WHERE id = $1', [posId]);
    if (rows.length === 0) throw new AppError(404, 'POS_NOT_FOUND', 'Point of sale not found');
    return rows[0].balance;
  }

  private async record(
    client: PoolClient,
    op: WalletOperation,
    type: 'DEBIT' | 'CREDIT' | 'ROLLBACK',
    rollsBackTxId: string | null,
    movement: number,
    balanceAfter: number,
  ) {
    const tx = await client.query<{ id: string }>(
      `INSERT INTO casino_transactions (pos_id, provider_tx_id, round_id, game_code, type, amount, rolls_back_tx_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [op.posId, op.providerTxId, op.roundId, op.gameCode, type, op.amount, rollsBackTxId],
    );
    // A zero-value credit (a lost round) or a tombstone changes no balance, so it has no ledger entry.
    if (movement !== 0) {
      const ledgerType = type === 'DEBIT' ? 'CASINO_DEBIT' : type === 'CREDIT' ? 'CASINO_CREDIT' : 'CASINO_ROLLBACK';
      await client.query(
        'INSERT INTO balance_movements (pos_id, type, amount, balance_after, casino_tx_id) VALUES ($1, $2, $3, $4, $5)',
        [op.posId, ledgerType, movement, balanceAfter, tx.rows[0].id],
      );
    }
  }
}
