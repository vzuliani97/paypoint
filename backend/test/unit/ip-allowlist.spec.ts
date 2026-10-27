import { isIpAllowed, normalizeIp } from '../../src/partner/ip-allowlist';

describe('IP allowlist', () => {
  it('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('10.1.2.3')).toBe('10.1.2.3');
  });

  it('matches exact addresses, including mapped IPv4', () => {
    expect(isIpAllowed('127.0.0.1', ['127.0.0.1'])).toBe(true);
    expect(isIpAllowed('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true);
    expect(isIpAllowed('::1', ['::1'])).toBe(true);
    expect(isIpAllowed('127.0.0.2', ['127.0.0.1'])).toBe(false);
  });

  it('matches CIDR ranges', () => {
    expect(isIpAllowed('172.18.0.5', ['172.16.0.0/12'])).toBe(true);
    expect(isIpAllowed('172.32.0.1', ['172.16.0.0/12'])).toBe(false);
    expect(isIpAllowed('2001:db8::42', ['2001:db8::/32'])).toBe(true);
  });

  it('denies by default and ignores invalid entries', () => {
    expect(isIpAllowed('10.0.0.1', [])).toBe(false);
    expect(isIpAllowed('10.0.0.1', ['not-an-ip', '10.0.0.0/99'])).toBe(false);
    expect(isIpAllowed(undefined, ['10.0.0.1'])).toBe(false);
    expect(isIpAllowed('garbage', ['10.0.0.1'])).toBe(false);
  });
});
