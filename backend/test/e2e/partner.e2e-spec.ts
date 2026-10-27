import { randomUUID } from 'node:crypto';
import { buildStringToSign, signRequest } from '../../src/partner/signature';
import { balanceOf, createPos, createProducts, createTestApp, resetDatabase, TestContext } from './helpers';

const SECRET = 'partner-e2e-secret-value';

interface SignOptions {
  keyId?: string;
  secret?: string;
  timestamp?: number;
  sendBody?: string;
  idempotencyKey?: string;
}

describe('Partner B2B API', () => {
  let ctx: TestContext;
  let posId: string;
  let topup: number;

  /** Signs like an integrator would, with options to break each part of the scheme. */
  const signed = (method: 'GET' | 'POST', path: string, body?: object, options: SignOptions = {}) => {
    const raw = body ? JSON.stringify(body) : '';
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = signRequest(options.secret ?? SECRET, buildStringToSign(timestamp, method, path, raw));

    const req = (method === 'GET' ? ctx.http().get(path) : ctx.http().post(path))
      .set('X-Api-Key', options.keyId ?? 'pk_test')
      .set('X-Timestamp', timestamp)
      .set('X-Signature', signature);

    if (options.idempotencyKey) {
      req.set('Idempotency-Key', options.idempotencyKey);
    }

    return body ? req.set('Content-Type', 'application/json').send(options.sendBody ?? raw) : req;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    ({ topup } = await createProducts(ctx.pool));
    posId = await createPos(ctx.pool, 'Tienda Integrada', 30_000);
    const otherPos = await createPos(ctx.pool, 'Tienda Lejana', 30_000);

    await ctx.pool.query(
      `INSERT INTO partners (name, api_key_id, hmac_secret, pos_id, allowed_ips) VALUES
         ('Integrador', 'pk_test', $1, $2, ARRAY['127.0.0.1', '::1']),
         ('Integrador remoto', 'pk_remote', $1, $3, ARRAY['10.0.0.0/8'])`,
      [SECRET, posId, otherPos],
    );
  });

  it('returns the balance for a correctly signed request', async () => {
    const response = await signed('GET', '/api/partner/v1/balance');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ posId, balance: 30_000 });
  });

  it('creates an idempotent sale on the partner channel', async () => {
    const body = { productId: topup, amount: 10_000, destination: '3157654321' };
    const idempotencyKey = randomUUID();

    const first = await signed('POST', '/api/partner/v1/sales', body, { idempotencyKey });
    const retry = await signed('POST', '/api/partner/v1/sales', body, { idempotencyKey });

    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ status: 'CONFIRMED', channel: 'PARTNER', posId });
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await balanceOf(ctx.pool, posId)).toBe(20_000);

    const read = await signed('GET', `/api/partner/v1/sales/${first.body.data.id}`);
    expect(read.body.status).toBe('CONFIRMED');
  });

  it('rejects a signature made with the wrong secret', async () => {
    const response = await signed('GET', '/api/partner/v1/balance', undefined, { secret: 'wrong-secret-value' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects a body modified after signing', async () => {
    const body = { productId: topup, amount: 1_000, destination: '3157654321' };
    const response = await signed('POST', '/api/partner/v1/sales', body, {
      idempotencyKey: randomUUID(),
      sendBody: JSON.stringify({ ...body, amount: 29_000 }),
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await balanceOf(ctx.pool, posId)).toBe(30_000);
  });

  it('rejects stale timestamps, which blocks replaying old captured requests', async () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const response = await signed('GET', '/api/partner/v1/balance', undefined, { timestamp: tenMinutesAgo });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('STALE_TIMESTAMP');
  });

  it('answers an unknown key exactly like a bad signature', async () => {
    const response = await signed('GET', '/api/partner/v1/balance', undefined, { keyId: 'pk_does_not_exist' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('requires all signature headers', async () => {
    const response = await ctx.http().get('/api/partner/v1/balance');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('MISSING_SIGNATURE');
  });

  it('blocks a valid signature coming from an IP outside the allowlist', async () => {
    const response = await signed('GET', '/api/partner/v1/balance', undefined, { keyId: 'pk_remote' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('IP_NOT_ALLOWED');
  });
});
