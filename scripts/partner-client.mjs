// Example integrator client: signs requests to the PayPoint partner API with HMAC-SHA256.
// Usage: make partner-demo   (or: PARTNER_SECRET=... node scripts/partner-client.mjs)
import { createHash, createHmac, randomUUID } from 'node:crypto';

const BASE_URL = process.env.PAYPOINT_URL ?? 'http://localhost:8081';
const KEY_ID = process.env.PARTNER_KEY_ID ?? 'pk_demo_tienda_centro';
const SECRET = process.env.PARTNER_SECRET ?? 'demo-partner-secret-change-me';

async function call(method, path, body) {
  const raw = body ? JSON.stringify(body) : '';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash('sha256').update(raw).digest('hex');
  const stringToSign = [timestamp, method, path, bodyHash].join('\n');
  const signature = createHmac('sha256', SECRET).update(stringToSign).digest('hex');

  const headers = { 'X-Api-Key': KEY_ID, 'X-Timestamp': timestamp, 'X-Signature': signature };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = randomUUID();
  }

  const response = await fetch(BASE_URL + path, { method, headers, body: body ? raw : undefined });
  console.log(`${method} ${path} -> ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
}

await call('GET', '/api/partner/v1/balance');
await call('POST', '/api/partner/v1/sales', { productId: 1, amount: 5000, destination: '3001234567' });
await call('GET', '/api/partner/v1/balance');
