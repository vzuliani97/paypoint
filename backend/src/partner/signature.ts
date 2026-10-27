import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The exact text both sides sign:
 *   <unix seconds>\n<METHOD>\n<path with query>\n<sha256 hex of the raw body>
 * Signing the body hash means any change to the payload breaks the signature.
 */
export function buildStringToSign(timestamp: string, method: string, path: string, rawBody: Buffer | string): string {
  return [timestamp, method.toUpperCase(), path, sha256Hex(rawBody)].join('\n');
}

export function signRequest(secret: string, stringToSign: string): string {
  return createHmac('sha256', secret).update(stringToSign).digest('hex');
}

/** Constant-time comparison, so response timing does not leak how many characters matched. */
export function signaturesMatch(received: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(received)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

/** Rejects old or future timestamps, which limits replays of a captured request. */
export function isTimestampFresh(timestamp: string, nowSeconds: number, toleranceSeconds: number): boolean {
  if (!/^\d{10}$/.test(timestamp)) {
    return false;
  }

  return Math.abs(nowSeconds - Number(timestamp)) <= toleranceSeconds;
}
