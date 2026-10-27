import { BlockList, isIP } from 'node:net';

/** "::ffff:127.0.0.1" (IPv4 seen through an IPv6 socket) becomes "127.0.0.1". */
export function normalizeIp(ip: string): string {
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return isIP(mapped) === 4 ? mapped : ip;
}

/** Checks an address against exact IPs and CIDR ranges, IPv4 or IPv6. Invalid entries are ignored. */
export function isIpAllowed(ip: string | undefined, allowed: string[]): boolean {
  if (!ip) {
    return false;
  }

  const address = normalizeIp(ip);
  const family = isIP(address);

  if (family === 0) {
    return false;
  }

  const list = new BlockList();

  for (const entry of allowed) {
    const [base, prefix] = entry.trim().split('/');
    const entryFamily = isIP(base);

    if (entryFamily === 0) {
      continue;
    }

    const type = entryFamily === 4 ? 'ipv4' : 'ipv6';

    if (prefix === undefined) {
      list.addAddress(base, type);
      continue;
    }

    const bits = Number(prefix);
    const maxBits = entryFamily === 4 ? 32 : 128;

    if (Number.isInteger(bits) && bits >= 0 && bits <= maxBits) {
      list.addSubnet(base, bits, type);
    }
  }

  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
