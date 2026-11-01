import { randomUUID } from 'node:crypto';
import {
  balanceOf,
  createPos,
  createProducts,
  createTestApp,
  createUser,
  ledgerSum,
  login,
  PASSWORD,
  resetDatabase,
  TestContext,
} from './helpers';

describe('Authentication and authorization', () => {
  let ctx: TestContext;
  let posA: string;
  let posB: string;
  let topup: number;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    ({ topup } = await createProducts(ctx.pool));
    posA = await createPos(ctx.pool, 'Tienda A', 50_000);
    posB = await createPos(ctx.pool, 'Tienda B', 50_000);
    await createUser(ctx.pool, 'admin@test.local', 'ADMIN', null);
    await createUser(ctx.pool, 'cajero.a@test.local', 'CASHIER', posA);
    await createUser(ctx.pool, 'cajero.b@test.local', 'CASHIER', posB);
  });

  it('exposes an unauthenticated health check outside the /api prefix', async () => {
    await ctx.http().get('/health').expect(200, { status: 'ok', database: 'ok' });
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await ctx.http().post('/api/auth/login').send({ email: 'admin@test.local', password: 'nope' });
    const unknownEmail = await ctx.http().post('/api/auth/login').send({ email: 'ghost@test.local', password: 'nope' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('locks one email from one address after 5 failed logins, even for the right password', async () => {
    await createUser(ctx.pool, 'locked@test.local', 'CASHIER', posA);
    const attempt = (email: string, password: string) => ctx.http().post('/api/auth/login').send({ email, password });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt('locked@test.local', 'wrong-password')).status).toBe(401);
    }
    const locked = await attempt('locked@test.local', PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(locked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

    // Another account from the same address still signs in.
    expect((await attempt('cajero.b@test.local', PASSWORD)).status).toBe(200);
  });

  it('rejects missing and tampered tokens', async () => {
    const missing = await ctx.http().get('/api/sales');
    expect(missing.status).toBe(401);

    const token = await login(ctx, 'cajero.a@test.local');
    const tampered = await ctx.http().get('/api/sales').set('Authorization', `Bearer ${token}x`);
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('UNAUTHORIZED');
  });

  it('does not let a cashier credit balance', async () => {
    const token = await login(ctx, 'cajero.a@test.local');

    const response = await ctx
      .http()
      .post(`/api/pos/${posA}/credits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 1_000_000 });

    expect(response.status).toBe(403);
    expect(await balanceOf(ctx.pool, posA)).toBe(50_000);
  });

  it('lets an admin credit balance and records it in the ledger', async () => {
    const token = await login(ctx, 'admin@test.local');

    const response = await ctx
      .http()
      .post(`/api/pos/${posA}/credits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 25_000, note: 'Consignación bancaria' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ posId: posA, balance: 75_000 });
    expect(await ledgerSum(ctx.pool, posA)).toBe(75_000);
  });

  it('keeps each cashier inside their own point of sale', async () => {
    const tokenA = await login(ctx, 'cajero.a@test.local');
    const tokenB = await login(ctx, 'cajero.b@test.local');

    const saleB = await ctx
      .http()
      .post('/api/sales')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('Idempotency-Key', randomUUID())
      .send({ productId: topup, amount: 2_000, destination: '3109876543' })
      .expect(201);

    const listA = await ctx.http().get('/api/sales').set('Authorization', `Bearer ${tokenA}`);
    expect(listA.body).toEqual([]);

    const readOther = await ctx.http().get(`/api/sales/${saleB.body.data.id}`).set('Authorization', `Bearer ${tokenA}`);
    expect(readOther.status).toBe(404);
  });
});
