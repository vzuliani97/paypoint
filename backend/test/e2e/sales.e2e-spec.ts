import { randomUUID } from 'node:crypto';
import {
  balanceOf,
  createPos,
  createProducts,
  createTestApp,
  createUser,
  ledgerSum,
  login,
  resetDatabase,
  TestContext,
} from './helpers';

describe('Sales through the portal', () => {
  let ctx: TestContext;
  let token: string;
  let posId: string;
  let products: { topup: number; giftCard: number };

  const sell = (body: Record<string, unknown>, key: string = randomUUID()) =>
    ctx.http().post('/api/sales').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    products = await createProducts(ctx.pool);
    posId = await createPos(ctx.pool, 'Tienda Test', 20_000);
    await createUser(ctx.pool, 'cajero@test.local', 'CASHIER', posId);
    token = await login(ctx, 'cajero@test.local');
  });

  it('confirms a sale and debits the prepaid balance', async () => {
    const response = await sell({ productId: products.topup, amount: 5_000, destination: '3001234567' });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ status: 'CONFIRMED', amount: 5_000, channel: 'PORTAL' });
    expect(response.body.data.providerReference).toMatch(/^SIM-/);
    expect(await balanceOf(ctx.pool, posId)).toBe(15_000);
    expect(await ledgerSum(ctx.pool, posId)).toBe(15_000);
  });

  it('exposes sales and HTTP metrics for Prometheus outside the /api prefix', async () => {
    await sell({ productId: products.topup, amount: 5_000, destination: '3001234567' }).expect(201);

    const metrics = await ctx.http().get('/metrics').expect(200);

    expect(metrics.text).toMatch(/paypoint_sales_total\{status="CONFIRMED",channel="PORTAL"\} \d+/);
    expect(metrics.text).toContain('route="/api/sales"');
  });

  it('never overdraws the balance under concurrent sales', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => sell({ productId: products.topup, amount: 3_000, destination: '3001234567' })),
    );

    const created = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 409);

    expect(created).toHaveLength(6);
    expect(rejected).toHaveLength(4);
    rejected.forEach((r) => expect(r.body.error.code).toBe('INSUFFICIENT_BALANCE'));
    expect(await balanceOf(ctx.pool, posId)).toBe(2_000);
    expect(await ledgerSum(ctx.pool, posId)).toBe(2_000);
  });

  it('stays consistent under 70 concurrent sales competing for the same balance', async () => {
    await ctx.pool.query('UPDATE points_of_sale SET balance = 100000 WHERE id = $1', [posId]);
    await ctx.pool.query(
      `INSERT INTO balance_movements (pos_id, type, amount, balance_after, note) VALUES ($1, 'CREDIT', 80000, 100000, 'top up')`,
      [posId],
    );

    // 70 × 2.000 = 140.000 requested against 100.000 available: exactly 50 must succeed.
    const responses = await Promise.all(
      Array.from({ length: 70 }, () => sell({ productId: products.topup, amount: 2_000, destination: '3001234567' })),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(50);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(20);
    expect(responses.some((r) => r.status >= 500)).toBe(false);
    expect(await balanceOf(ctx.pool, posId)).toBe(0);
    expect(await ledgerSum(ctx.pool, posId)).toBe(0);
  });

  it('turns 70 concurrent retries of the same request into a single sale', async () => {
    const key = randomUUID();
    const body = { productId: products.topup, amount: 5_000, destination: '3001234567' };

    const responses = await Promise.all(Array.from({ length: 70 }, () => sell(body, key)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(69);
    expect(new Set(responses.map((r) => r.body.data.id)).size).toBe(1);
    expect(await balanceOf(ctx.pool, posId)).toBe(15_000);
  });

  it('processes concurrent retries with the same Idempotency-Key only once', async () => {
    const key = randomUUID();
    const body = { productId: products.topup, amount: 5_000, destination: '3001234567' };

    const responses = await Promise.all(Array.from({ length: 5 }, () => sell(body, key)));

    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(responses.map((r) => r.body.data.id)).size).toBe(1);
    expect(await balanceOf(ctx.pool, posId)).toBe(15_000);

    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM balance_movements WHERE type = 'SALE'");
    expect(rows[0].n).toBe(1);
  });

  it('rejects an Idempotency-Key reused with different data', async () => {
    const key = randomUUID();
    await sell({ productId: products.topup, amount: 5_000, destination: '3001234567' }, key).expect(201);

    const response = await sell({ productId: products.topup, amount: 9_000, destination: '3001234567' }, key);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balanceOf(ctx.pool, posId)).toBe(15_000);
  });

  it('refunds the balance exactly once when the provider rejects the sale', async () => {
    const response = await sell({ productId: products.topup, amount: 5_000, destination: '3001230000' });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ status: 'FAILED', failureReason: 'DESTINATION_REJECTED' });
    expect(await balanceOf(ctx.pool, posId)).toBe(20_000);
    expect(await ledgerSum(ctx.pool, posId)).toBe(20_000);

    const movements = await ctx.http().get('/api/pos/me/movements').set('Authorization', `Bearer ${token}`);
    expect(movements.body.map((m: { type: string }) => m.type)).toEqual(['REFUND', 'SALE', 'CREDIT']);
  });

  it('validates amount ranges and destinations per product', async () => {
    const tooBig = await sell({ productId: products.topup, amount: 60_000, destination: '3001234567' });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatchObject({ code: 'INVALID_AMOUNT', details: { min: 1_000, max: 50_000 } });

    const wrongDestination = await sell({ productId: products.giftCard, amount: 20_000, destination: '3001234567' });
    expect(wrongDestination.status).toBe(400);
    expect(wrongDestination.body.error.code).toBe('INVALID_DESTINATION');

    const extraField = await sell({ productId: products.topup, amount: 5_000, destination: '3001234567', posId });
    expect(extraField.status).toBe(400);
    expect(extraField.body.error.code).toBe('INVALID_INPUT');

    expect(await balanceOf(ctx.pool, posId)).toBe(20_000);
  });

  it('requires a valid Idempotency-Key header', async () => {
    const response = await ctx
      .http()
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: products.topup, amount: 5_000, destination: '3001234567' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });
});

describe('Sales when the provider does not answer', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // A provider that never responds: the API must time out instead of hanging.
    ctx = await createTestApp({ provider: { send: () => new Promise(() => undefined) } });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('keeps the sale PENDING and does not refund, because the outcome is unknown', async () => {
    await resetDatabase(ctx.pool);
    const products = await createProducts(ctx.pool);
    const posId = await createPos(ctx.pool, 'Tienda Lenta', 20_000);
    await createUser(ctx.pool, 'lento@test.local', 'CASHIER', posId);
    const token = await login(ctx, 'lento@test.local');

    const response = await ctx
      .http()
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ productId: products.topup, amount: 5_000, destination: '3001234567' });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('PENDING');
    expect(await balanceOf(ctx.pool, posId)).toBe(15_000);
    expect(await ledgerSum(ctx.pool, posId)).toBe(15_000);
  });
});
