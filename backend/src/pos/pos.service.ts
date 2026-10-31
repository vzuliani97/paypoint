import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import { DatabaseService } from '../database/database.service';

interface PosRow {
  id: string;
  name: string;
  balance: number;
  active: boolean;
  created_at: Date;
}

interface MovementRow {
  id: string;
  type: 'CREDIT' | 'SALE' | 'REFUND' | 'BET' | 'BET_PAYOUT' | 'CASINO_DEBIT' | 'CASINO_CREDIT' | 'CASINO_ROLLBACK';
  amount: number;
  balance_after: number;
  sale_id: string | null;
  note: string | null;
  created_at: Date;
}

const toPos = (row: PosRow) => ({
  id: row.id,
  name: row.name,
  balance: row.balance,
  active: row.active,
  createdAt: row.created_at,
});

const toMovement = (row: MovementRow) => ({
  id: Number(row.id),
  type: row.type,
  amount: row.amount,
  balanceAfter: row.balance_after,
  saleId: row.sale_id,
  note: row.note,
  createdAt: row.created_at,
});

@Injectable()
export class PosService {
  constructor(private readonly db: DatabaseService) {}

  async list() {
    const { rows } = await this.db.query<PosRow>(
      'SELECT id, name, balance, active, created_at FROM points_of_sale ORDER BY name',
    );
    return rows.map(toPos);
  }

  async get(posId: string) {
    const { rows } = await this.db.query<PosRow>(
      'SELECT id, name, balance, active, created_at FROM points_of_sale WHERE id = $1',
      [posId],
    );

    if (rows.length === 0) {
      throw new AppError(404, 'POS_NOT_FOUND', 'Point of sale not found');
    }

    return toPos(rows[0]);
  }

  async create(name: string) {
    const { rows } = await this.db.query<PosRow>(
      `INSERT INTO points_of_sale (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, balance, active, created_at`,
      [name],
    );

    if (rows.length === 0) {
      throw new AppError(409, 'POS_NAME_TAKEN', 'A point of sale with that name already exists');
    }

    return toPos(rows[0]);
  }

  /** Adds prepaid balance and records the CREDIT in the ledger, atomically. */
  async credit(posId: string, amount: number, note: string | undefined, adminId: string) {
    return this.db.transaction(async (client) => {
      const updated = await client.query<{ balance: number }>(
        `UPDATE points_of_sale
         SET balance = balance + $1, updated_at = now()
         WHERE id = $2 AND active
         RETURNING balance`,
        [amount, posId],
      );

      if (updated.rowCount === 0) {
        throw new AppError(404, 'POS_NOT_FOUND', 'Point of sale not found or inactive');
      }

      const balance = updated.rows[0].balance;
      await client.query(
        `INSERT INTO balance_movements (pos_id, type, amount, balance_after, note, created_by)
         VALUES ($1, 'CREDIT', $2, $3, $4, $5)`,
        [posId, amount, balance, note ?? null, adminId],
      );

      return { posId, balance };
    });
  }

  async movements(posId: string, limit = 50) {
    const { rows } = await this.db.query<MovementRow>(
      `SELECT id, type, amount, balance_after, sale_id, note, created_at
       FROM balance_movements
       WHERE pos_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [posId, limit],
    );
    return rows.map(toMovement);
  }
}
