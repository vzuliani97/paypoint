import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { BettingService } from '../../src/betting/betting.service';
import { LiveFeedService } from '../../src/betting/live-feed.service';
import { buildStringToSign, signRequest } from '../../src/partner/signature';
import { balanceOf, createPos, createTestApp, createUser, ledgerSum, login, resetDatabase, TestContext } from './helpers';

const CASINO_SECRET = 'demo-casino-provider-secret-change-me';

describe('Live betting and casino', () => {
  let ctx: TestContext;
  let posId: string;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    posId = await createPos(ctx.pool, 'Tienda Centro', 50_000);
    await createUser(ctx.pool, 'cajero@test.local', 'CASHIER', posId);
    token = await login(ctx, 'cajero@test.local');
  });

  /** A match with 1X2 odds of 2.00 / 3.20 / 3.50. */
  async function createEvent(status: 'SCHEDULED' | 'LIVE' | 'FINISHED' = 'LIVE', minute = 30, score: [number, number] = [0, 0]) {
    const event = await ctx.pool.query<{ id: number }>(
      `INSERT INTO sports_events (sport, league, home, away, starts_at, status, minute, home_score, away_score)
       VALUES ('FUTBOL', 'Liga Demo', 'Atlético Andino', 'Deportivo Caribe', now(), $1, $2, $3, $4) RETURNING id`,
      [status, minute, score[0], score[1]],
    );
    const eventId = event.rows[0].id;
    const selections = await ctx.pool.query<{ id: number; code: string }>(
      `INSERT INTO selections (event_id, code, odds_x100) VALUES ($1, 'HOME', 200), ($1, 'DRAW', 320), ($1, 'AWAY', 350)
       RETURNING id, code`,
      [eventId],
    );
    const id = (code: string) => selections.rows.find((row) => row.code === code)!.id;
    return { eventId, home: id('HOME'), draw: id('DRAW'), away: id('AWAY') };
  }

  const bet = (selectionId: number, stake: number, acceptedOdds: number, key = randomUUID()) =>
    ctx
      .http()
      .post('/api/betting/bets')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ selectionId, stake, acceptedOdds });

  it('places a bet: debits the stake, records it in the ledger and keeps the accepted odds', async () => {
    const event = await createEvent();

    const response = await bet(event.home, 10_000, 2);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ pick: 'HOME', stake: 10_000, odds: 2, potentialPayout: 20_000, status: 'OPEN' });
    expect(await balanceOf(ctx.pool, posId)).toBe(40_000);
    expect(await ledgerSum(ctx.pool, posId)).toBe(40_000);
  });

  it('replays a retried bet and rejects a reused key with different data', async () => {
    const event = await createEvent();
    const key = randomUUID();

    const first = await bet(event.home, 10_000, 2, key);
    const retry = await bet(event.home, 10_000, 2, key);
    const changed = await bet(event.home, 20_000, 2, key);

    expect([first.status, retry.status, changed.status]).toEqual([201, 200, 409]);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balanceOf(ctx.pool, posId)).toBe(40_000);
  });

  it('refuses a bet when the odds moved since the cashier saw them, without moving money', async () => {
    const event = await createEvent();
    await ctx.pool.query('UPDATE selections SET odds_x100 = 185 WHERE id = $1', [event.home]);

    const response = await bet(event.home, 10_000, 2);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'ODDS_CHANGED', details: { currentOdds: 185 } });
    expect(await balanceOf(ctx.pool, posId)).toBe(50_000);
  });

  it('refuses bets on finished events and suspended markets, and stakes outside the limits', async () => {
    const finished = await createEvent('FINISHED', 90, [1, 0]);
    const live = await createEvent();
    await ctx.pool.query('UPDATE selections SET suspended = TRUE WHERE id = $1', [live.draw]);

    const closed = await bet(finished.home, 10_000, 2);
    const suspended = await bet(live.draw, 10_000, 3.2);
    const tooSmall = await bet(live.home, 500, 2);

    expect([closed.body.error.code, suspended.body.error.code, tooSmall.body.error.code]).toEqual([
      'EVENT_CLOSED',
      'MARKET_SUSPENDED',
      'STAKE_OUT_OF_RANGE',
    ]);
    expect(await balanceOf(ctx.pool, posId)).toBe(50_000);
  });

  it('accepts only what the balance covers when ten bets race', async () => {
    const event = await createEvent();

    const responses = await Promise.all(Array.from({ length: 10 }, () => bet(event.home, 10_000, 2)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(5);
    expect(responses.filter((r) => r.status === 409 && r.body.error.code === 'INSUFFICIENT_BALANCE')).toHaveLength(5);
    expect(await balanceOf(ctx.pool, posId)).toBe(0);
    expect(await ledgerSum(ctx.pool, posId)).toBe(0);
  });

  it('settles a finished match once: winners are paid, losers closed, and a second run changes nothing', async () => {
    const event = await createEvent();
    await bet(event.home, 10_000, 2).expect(201);
    await bet(event.away, 5_000, 3.5).expect(201);
    await ctx.pool.query("UPDATE sports_events SET status = 'FINISHED', minute = 90, home_score = 2, away_score = 1 WHERE id = $1", [
      event.eventId,
    ]);
    const betting = ctx.app.get(BettingService);

    const first = await betting.settleEvent(event.eventId);
    const second = await betting.settleEvent(event.eventId);

    expect(first).toEqual({ won: 1, lost: 1 });
    expect(second).toEqual({ won: 0, lost: 0 });
    // 50.000 - 10.000 - 5.000 + 20.000 paid once.
    expect(await balanceOf(ctx.pool, posId)).toBe(55_000);
    expect(await ledgerSum(ctx.pool, posId)).toBe(55_000);
  });

  it('live feed: a tick moves the clock and the prices, and a match that reaches 90 minutes is settled', async () => {
    const ending = await createEvent('LIVE', 89, [1, 0]);
    const running = await createEvent('LIVE', 30, [0, 0]);
    await bet(ending.home, 10_000, 2).expect(201);
    const feed = ctx.app.get(LiveFeedService);

    const finished = await feed.tick(() => 0.9); // 0.9: no goals in this tick

    expect(finished).toEqual([ending.eventId]);
    const events = await ctx.pool.query('SELECT id, status, minute FROM sports_events WHERE id = ANY($1) ORDER BY id', [
      [ending.eventId, running.eventId],
    ]);
    expect(events.rows).toEqual([
      { id: ending.eventId, status: 'FINISHED', minute: 90 },
      { id: running.eventId, status: 'LIVE', minute: 31 },
    ]);
    const odds = await ctx.pool.query<{ odds_x100: number }>('SELECT odds_x100 FROM selections WHERE id = $1', [running.draw]);
    expect(odds.rows[0].odds_x100).not.toBe(320); // a level match moves toward the draw
    expect(await balanceOf(ctx.pool, posId)).toBe(60_000);
    // The feed refilled the board to six open matches before this tick finished one of them.
    const open = await ctx.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM sports_events WHERE status <> 'FINISHED'");
    expect(open.rows[0].n).toBe(5);
  });

  it('streams the live board as server-sent events', async () => {
    await createEvent();
    const { port } = ctx.app.getHttpServer().address() as AddressInfo;
    const controller = new AbortController();

    const response = await fetch(`http://127.0.0.1:${port}/api/betting/stream`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let text = '';
    while (!/^data: .*$/m.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
    }
    controller.abort();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const payload = JSON.parse(/^data: (.*)$/m.exec(text)![1]);
    expect(payload[0]).toMatchObject({ home: 'Atlético Andino', status: 'LIVE', selections: expect.any(Array) });
  });

  describe('casino', () => {
    const signed = (path: string, body: Record<string, unknown>, secret = CASINO_SECRET) => {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      return ctx
        .http()
        .post(path)
        .set('Content-Type', 'application/json')
        .set('X-Timestamp', timestamp)
        .set('X-Signature', signRequest(secret, buildStringToSign(timestamp, 'POST', path, raw)))
        .send(raw);
    };

    it('plays a round through the cashier, and a retried round is replayed, not played again', async () => {
      const play = (key: string) =>
        ctx
          .http()
          .post('/api/casino/rounds')
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send({ gameCode: 'RULETA_ANDINA', stake: 10_000 });
      const key = randomUUID();

      const first = await play(key);
      const retry = await play(key);

      expect(first.status).toBe(200);
      expect(retry.body).toMatchObject({ roundId: first.body.roundId, win: first.body.win, replayed: true });
      expect(await balanceOf(ctx.pool, posId)).toBe(50_000 - 10_000 + first.body.win);
      expect(await ledgerSum(ctx.pool, posId)).toBe(await balanceOf(ctx.pool, posId));
    });

    it('applies each signed wallet callback once, whatever the provider retries', async () => {
      const debit = { posId, providerTxId: 'prov-tx-0001', roundId: 'round-0001', gameCode: 'RULETA_ANDINA', amount: 8_000 };
      const credit = { ...debit, providerTxId: 'prov-tx-0002', amount: 16_000 };

      const first = await signed('/api/casino/wallet/debit', debit);
      const retry = await signed('/api/casino/wallet/debit', debit);
      const win = await signed('/api/casino/wallet/credit', credit);
      const forged = await signed('/api/casino/wallet/credit', { ...credit, providerTxId: 'prov-tx-0003' }, 'not-the-provider-secret');

      expect([first.body.status, retry.body.status, win.body.status]).toEqual(['APPLIED', 'ALREADY_APPLIED', 'APPLIED']);
      expect(forged.status).toBe(401);
      expect(await balanceOf(ctx.pool, posId)).toBe(50_000 - 8_000 + 16_000);
      expect(await ledgerSum(ctx.pool, posId)).toBe(58_000);
    });

    it('refuses a late debit whose rollback arrived first, and refunds a rolled-back debit once', async () => {
      const base = { posId, roundId: 'round-0002', gameCode: 'TRAGAMONEDAS_CAFE' };

      const early = await signed('/api/casino/wallet/rollback', { ...base, providerTxId: 'prov-rb-0001', rollsBackTxId: 'prov-tx-0100' });
      const late = await signed('/api/casino/wallet/debit', { ...base, providerTxId: 'prov-tx-0100', amount: 5_000 });

      expect(early.body.status).toBe('ROLLBACK_RECORDED');
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('ALREADY_ROLLED_BACK');
      expect(await balanceOf(ctx.pool, posId)).toBe(50_000);

      await signed('/api/casino/wallet/debit', { ...base, providerTxId: 'prov-tx-0200', amount: 5_000 }).expect(200);
      const refund = { ...base, providerTxId: 'prov-rb-0002', rollsBackTxId: 'prov-tx-0200' };
      await signed('/api/casino/wallet/rollback', refund).expect(200);
      await signed('/api/casino/wallet/rollback', refund).expect(200);

      expect(await balanceOf(ctx.pool, posId)).toBe(50_000);
      expect(await ledgerSum(ctx.pool, posId)).toBe(50_000);
    });
  });
});
