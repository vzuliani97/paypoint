import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { Product, ProductsService } from '../catalog/products.service';
import { AppError } from '../common/app-error';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { MetricsService } from '../metrics/metrics.module';
import { ProviderRequest, TOPUP_PROVIDER, TopupProvider } from './provider/topup-provider';

export type SaleChannel = 'PORTAL' | 'PARTNER';
export type SaleStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

export interface CreateSaleCommand {
  posId: string;
  productId: number;
  amount: number;
  destination: string;
  idempotencyKey: string;
  channel: SaleChannel;
}

interface SaleRow {
  id: string;
  pos_id: string;
  product_id: number;
  product_name: string;
  amount: number;
  destination: string;
  channel: SaleChannel;
  status: SaleStatus;
  provider_reference: string | null;
  failure_reason: string | null;
  request_hash: string;
  created_at: Date;
  updated_at: Date;
}

type ProviderOutcome =
  | { kind: 'confirmed'; reference: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unknown'; reason: string };

const SELECT_SALE = `
  SELECT s.*, p.name AS product_name
  FROM sales s
  JOIN products p ON p.id = s.product_id
`;

const COLOMBIAN_MOBILE = /^3\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const toSale = (row: SaleRow) => ({
  id: row.id,
  posId: row.pos_id,
  productId: row.product_id,
  productName: row.product_name,
  amount: row.amount,
  destination: row.destination,
  channel: row.channel,
  status: row.status,
  providerReference: row.provider_reference,
  failureReason: row.failure_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type Sale = ReturnType<typeof toSale>;

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly products: ProductsService,
    @Inject(TOPUP_PROVIDER) private readonly provider: TopupProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * 1. Short transaction: idempotency check, atomic debit, PENDING sale and ledger entry.
   * 2. Provider call, outside any transaction, so no row lock is held during network I/O.
   * 3. Short transaction: CONFIRMED, or FAILED plus refund.
   */
  async createSale(command: CreateSaleCommand): Promise<{ sale: Sale; replayed: boolean }> {
    const product = await this.products.getActive(command.productId);
    this.validateAmount(product, command.amount);
    this.validateDestination(product, command.destination);

    const requestHash = createHash('sha256')
      .update(JSON.stringify([command.productId, command.amount, command.destination]))
      .digest('hex');

    const reserved = await this.db.transaction(async (client) => {
      // Two requests with the same key wait for each other instead of both creating a sale.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${command.posId}:${command.idempotencyKey}`,
      ]);

      const existing = await client.query<SaleRow>(
        `${SELECT_SALE} WHERE s.pos_id = $1 AND s.idempotency_key = $2`,
        [command.posId, command.idempotencyKey],
      );

      if (existing.rows.length > 0) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with different data');
        }
        return { row: existing.rows[0], replayed: true };
      }

      // Check and debit in one statement: no gap between reading the balance and writing it.
      const debit = await client.query<{ balance: number }>(
        `UPDATE points_of_sale
         SET balance = balance - $1, updated_at = now()
         WHERE id = $2 AND active AND balance >= $1
         RETURNING balance`,
        [command.amount, command.posId],
      );

      if (debit.rows.length === 0) {
        await this.throwDebitFailure(client, command);
      }

      const inserted = await client.query<SaleRow>(
        `INSERT INTO sales (pos_id, product_id, amount, destination, channel, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          command.posId,
          command.productId,
          command.amount,
          command.destination,
          command.channel,
          command.idempotencyKey,
          requestHash,
        ],
      );
      const sale = { ...inserted.rows[0], product_name: product.name };

      await client.query(
        `INSERT INTO balance_movements (pos_id, type, amount, balance_after, sale_id)
         VALUES ($1, 'SALE', $2, $3, $4)`,
        [command.posId, -command.amount, debit.rows[0].balance, sale.id],
      );

      return { row: sale, replayed: false };
    });

    if (reserved.replayed) {
      return { sale: toSale(reserved.row), replayed: true };
    }

    const outcome = await this.callProvider({
      saleId: reserved.row.id,
      productCode: product.code,
      amount: command.amount,
      destination: command.destination,
    });

    const sale = await this.applyOutcome(reserved.row, outcome);
    this.metrics.sales.inc({ status: sale.status, channel: sale.channel });

    return { sale, replayed: false };
  }

  async getSale(saleId: string, posId?: string): Promise<Sale> {
    const params: unknown[] = [saleId];
    let sql = `${SELECT_SALE} WHERE s.id = $1`;

    if (posId) {
      params.push(posId);
      sql += ' AND s.pos_id = $2';
    }

    const { rows } = await this.db.query<SaleRow>(sql, params);

    if (rows.length === 0) {
      throw new AppError(404, 'SALE_NOT_FOUND', 'Sale not found');
    }

    return toSale(rows[0]);
  }

  async listSales(posId?: string, limit = 50): Promise<Sale[]> {
    const { rows } = posId
      ? await this.db.query<SaleRow>(`${SELECT_SALE} WHERE s.pos_id = $1 ORDER BY s.created_at DESC LIMIT $2`, [
          posId,
          limit,
        ])
      : await this.db.query<SaleRow>(`${SELECT_SALE} ORDER BY s.created_at DESC LIMIT $1`, [limit]);

    return rows.map(toSale);
  }

  private validateAmount(product: Product, amount: number): void {
    if (amount < product.minAmount || amount > product.maxAmount) {
      throw new AppError(400, 'INVALID_AMOUNT', `Amount must be between ${product.minAmount} and ${product.maxAmount}`, {
        min: product.minAmount,
        max: product.maxAmount,
      });
    }
  }

  private validateDestination(product: Product, destination: string): void {
    const valid = product.type === 'TOPUP' ? COLOMBIAN_MOBILE.test(destination) : EMAIL.test(destination);

    if (!valid) {
      const expected = product.type === 'TOPUP' ? 'a 10-digit Colombian mobile number' : 'an email address';
      throw new AppError(400, 'INVALID_DESTINATION', `Destination must be ${expected}`);
    }
  }

  private async throwDebitFailure(client: PoolClient, command: CreateSaleCommand): Promise<never> {
    const { rows } = await client.query<{ balance: number }>(
      'SELECT balance FROM points_of_sale WHERE id = $1 AND active',
      [command.posId],
    );

    if (rows.length === 0) {
      throw new AppError(404, 'POS_NOT_FOUND', 'Point of sale not found or inactive');
    }

    throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Not enough prepaid balance', {
      balance: rows[0].balance,
      amount: command.amount,
    });
  }

  private async callProvider(request: ProviderRequest): Promise<ProviderOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.config.PROVIDER_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([this.provider.send(request), timeout]);

      if (result === 'timeout') {
        return { kind: 'unknown', reason: 'PROVIDER_TIMEOUT' };
      }

      return result.ok ? { kind: 'confirmed', reference: result.reference } : { kind: 'rejected', reason: result.reason };
    } catch (error) {
      this.logger.error(`Provider call failed for sale ${request.saleId}: ${(error as Error).message}`);
      return { kind: 'unknown', reason: 'PROVIDER_ERROR' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async applyOutcome(row: SaleRow, outcome: ProviderOutcome): Promise<Sale> {
    // Timeout or network error: the provider may still have processed the top-up.
    // Refunding now could give the product away for free, so the sale stays PENDING for reconciliation.
    if (outcome.kind === 'unknown') {
      this.logger.warn(`Sale ${row.id} left PENDING: ${outcome.reason}`);
      return toSale(row);
    }

    if (outcome.kind === 'confirmed') {
      const { rows } = await this.db.query<SaleRow>(
        `UPDATE sales SET status = 'CONFIRMED', provider_reference = $2, updated_at = now()
         WHERE id = $1 AND status = 'PENDING'
         RETURNING *`,
        [row.id, outcome.reference],
      );
      return rows[0] ? toSale({ ...rows[0], product_name: row.product_name }) : this.getSale(row.id);
    }

    return this.db.transaction(async (client) => {
      // "AND status = 'PENDING'" makes this a one-time transition, so the refund cannot run twice.
      const failed = await client.query<SaleRow>(
        `UPDATE sales SET status = 'FAILED', failure_reason = $2, updated_at = now()
         WHERE id = $1 AND status = 'PENDING'
         RETURNING *`,
        [row.id, outcome.reason],
      );

      if (failed.rows.length === 0) {
        return this.getSale(row.id);
      }

      const refund = await client.query<{ balance: number }>(
        `UPDATE points_of_sale SET balance = balance + $1, updated_at = now()
         WHERE id = $2
         RETURNING balance`,
        [row.amount, row.pos_id],
      );

      await client.query(
        `INSERT INTO balance_movements (pos_id, type, amount, balance_after, sale_id, note)
         VALUES ($1, 'REFUND', $2, $3, $4, $5)`,
        [row.pos_id, row.amount, refund.rows[0].balance, row.id, outcome.reason],
      );

      return toSale({ ...failed.rows[0], product_name: row.product_name });
    });
  }
}
