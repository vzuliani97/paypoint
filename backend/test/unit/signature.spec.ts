import {
  buildStringToSign,
  isTimestampFresh,
  sha256Hex,
  signaturesMatch,
  signRequest,
} from '../../src/partner/signature';

describe('partner request signature', () => {
  const secret = 'unit-test-secret-value';

  it('builds the canonical string from timestamp, method, path and body hash', () => {
    const body = '{"amount":5000}';

    expect(buildStringToSign('1761600000', 'post', '/api/partner/v1/sales', body)).toBe(
      ['1761600000', 'POST', '/api/partner/v1/sales', sha256Hex(body)].join('\n'),
    );
  });

  it('uses the hash of an empty body for requests without payload', () => {
    expect(buildStringToSign('1761600000', 'GET', '/x', Buffer.alloc(0)).split('\n')[3]).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('accepts the correct signature and rejects any other', () => {
    const stringToSign = buildStringToSign('1761600000', 'GET', '/api/partner/v1/balance', '');
    const signature = signRequest(secret, stringToSign);

    expect(signaturesMatch(signature, signRequest(secret, stringToSign))).toBe(true);
    expect(signaturesMatch(signature, signRequest('another-secret', stringToSign))).toBe(false);
  });

  it('changes when the body changes', () => {
    const original = signRequest(secret, buildStringToSign('1761600000', 'POST', '/s', '{"amount":5000}'));
    const tampered = signRequest(secret, buildStringToSign('1761600000', 'POST', '/s', '{"amount":50000}'));

    expect(signaturesMatch(original, tampered)).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    const expected = signRequest(secret, 'anything');

    expect(signaturesMatch('', expected)).toBe(false);
    expect(signaturesMatch('not-hex', expected)).toBe(false);
    expect(signaturesMatch(expected.slice(0, 10), expected)).toBe(false);
  });

  it('only accepts timestamps inside the tolerance window', () => {
    const now = 1_761_600_000;

    expect(isTimestampFresh(String(now), now, 300)).toBe(true);
    expect(isTimestampFresh(String(now - 300), now, 300)).toBe(true);
    expect(isTimestampFresh(String(now - 301), now, 300)).toBe(false);
    expect(isTimestampFresh(String(now + 301), now, 300)).toBe(false);
    expect(isTimestampFresh('abc', now, 300)).toBe(false);
    expect(isTimestampFresh('1761600000000', now, 300)).toBe(false);
  });
});
