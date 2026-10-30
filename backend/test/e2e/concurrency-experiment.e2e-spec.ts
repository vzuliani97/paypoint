import { Pool } from 'pg';
import { createPos, createTestApp, resetDatabase, TestContext } from './helpers';

/**
 * Before/after experiment behind PayPoint's debit design.
 * 70 concurrent debits of 2,000 against a balance of 100,000 (room for exactly 50).
 * "naive" reads the balance, checks it in code, then writes the new value: the classic lost-update race.
 * "safe" is what SalesService does: check and debit in one conditional UPDATE.
 */
const REQUESTS = 70;
const AMOUNT = 2_000;
const START = 100_000;

async function naiveDebit(pool: Pool, posId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ balance: number }>('SELECT balance FROM points_of_sale WHERE id = $1', [posId]);
    if (rows[0].balance < AMOUNT) {
      await client.query('ROLLBACK');
      return false;
    }
    // Simulates the time an app spends between reading and writing (validation, a network call...).
    await client.query('SELECT pg_sleep(0.01)');
    await client.query('UPDATE points_of_sale SET balance = $1 WHERE id = $2', [rows[0].balance - AMOUNT, posId]);
    await client.query('COMMIT');
    return true;
  } finally {
    client.release();
  }
}

async function safeDebit(pool: Pool, posId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE points_of_sale SET balance = balance - $1 WHERE id = $2 AND balance >= $1',
    [AMOUNT, posId],
  );
  return rowCount === 1;
}

async function run(pool: Pool, posId: string, debit: (pool: Pool, posId: string) => Promise<boolean>) {
  const results = await Promise.all(Array.from({ length: REQUESTS }, () => debit(pool, posId)));
  const approved = results.filter(Boolean).length;
  const { rows } = await pool.query<{ balance: number }>('SELECT balance FROM points_of_sale WHERE id = $1', [posId]);
  const expectedBalance = START - approved * AMOUNT;
  return { approved, finalBalance: rows[0].balance, expectedBalance, lostCop: rows[0].balance - expectedBalance };
}

describe('Concurrency experiment: naive read-then-write vs conditional UPDATE', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.pool);
  });

  it('naive: approves debits whose money is never actually taken (lost updates)', async () => {
    const posId = await createPos(ctx.pool, 'Naive', START);
    const result = await run(ctx.pool, posId, naiveDebit);
    console.log('naive', JSON.stringify(result));

    // The stored balance no longer matches the approved sales: money was created out of nothing.
    expect(result.finalBalance).toBeGreaterThan(result.expectedBalance);
  });

  it('safe: approves exactly 50 and the balance always matches', async () => {
    const posId = await createPos(ctx.pool, 'Safe', START);
    const result = await run(ctx.pool, posId, safeDebit);
    console.log('safe', JSON.stringify(result));

    expect(result).toEqual({ approved: 50, finalBalance: 0, expectedBalance: 0, lostCop: 0 });
  });
});
