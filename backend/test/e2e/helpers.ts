import 'reflect-metadata';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, AppConfig } from '../../src/config';
import { DatabaseService } from '../../src/database/database.service';
import { runMigrations } from '../../src/database/migrate';
import { TOPUP_PROVIDER, TopupProvider } from '../../src/sales/provider/topup-provider';
import { configureApp } from '../../src/setup';

export const PASSWORD = 'correct-horse-battery';

export interface TestContext {
  app: NestExpressApplication;
  pool: Pool;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(options: { provider?: TopupProvider } = {}): Promise<TestContext> {
  let builder = Test.createTestingModule({ imports: [AppModule] });

  if (options.provider) {
    builder = builder.overrideProvider(TOPUP_PROVIDER).useValue(options.provider);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
  configureApp(app, app.get<AppConfig>(APP_CONFIG));
  // Listen once on an ephemeral port; otherwise supertest opens a new server per request.
  await app.listen(0, '127.0.0.1');

  const pool = app.get(DatabaseService).pool;
  await runMigrations(pool);

  return { app, pool, http: () => request(app.getHttpServer()) };
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE balance_movements, sales, partners, users, products, points_of_sale RESTART IDENTITY CASCADE',
  );
}

export async function createProducts(pool: Pool): Promise<{ topup: number; giftCard: number }> {
  const { rows } = await pool.query<{ id: number; code: string }>(`
    INSERT INTO products (code, name, type, min_amount, max_amount) VALUES
      ('TEST_TOPUP', 'Recarga de prueba', 'TOPUP', 1000, 50000),
      ('TEST_GIFT', 'Gift card de prueba', 'GIFT_CARD', 20000, 20000)
    RETURNING id, code
  `);

  return {
    topup: rows.find((row) => row.code === 'TEST_TOPUP')!.id,
    giftCard: rows.find((row) => row.code === 'TEST_GIFT')!.id,
  };
}

/** Creates a point of sale whose opening balance is backed by a CREDIT movement, like real data. */
export async function createPos(pool: Pool, name: string, balance: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO points_of_sale (name, balance) VALUES ($1, $2) RETURNING id',
    [name, balance],
  );

  if (balance > 0) {
    await pool.query(
      `INSERT INTO balance_movements (pos_id, type, amount, balance_after, note)
       VALUES ($1, 'CREDIT', $2, $2, 'Saldo inicial')`,
      [rows[0].id, balance],
    );
  }

  return rows[0].id;
}

let cachedHash: string | undefined;

export async function createUser(pool: Pool, email: string, role: 'ADMIN' | 'CASHIER', posId: string | null) {
  cachedHash ??= await bcrypt.hash(PASSWORD, 4);
  await pool.query('INSERT INTO users (email, password_hash, role, pos_id) VALUES ($1, $2, $3, $4)', [
    email,
    cachedHash,
    role,
    posId,
  ]);
}

export async function login(ctx: TestContext, email: string): Promise<string> {
  const response = await ctx.http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return response.body.accessToken as string;
}

export async function balanceOf(pool: Pool, posId: string): Promise<number> {
  const { rows } = await pool.query<{ balance: number }>('SELECT balance FROM points_of_sale WHERE id = $1', [posId]);
  return rows[0].balance;
}

/** The ledger invariant: the stored balance always equals the sum of all movements. */
export async function ledgerSum(pool: Pool, posId: string): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM balance_movements WHERE pos_id = $1',
    [posId],
  );
  return Number(rows[0].total);
}
