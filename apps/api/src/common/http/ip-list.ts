import { BlockList, isIP } from 'node:net';

/** Strip the IPv4-mapped prefix so `::ffff:203.0.113.10` matches an IPv4 rule. */
export function normalizeIp(ip: string | null | undefined): string {
  return ip?.replace(/^::ffff:/, '') ?? '';
}

/** A matcher over addresses and CIDRs (`203.0.113.10`, `203.0.113.0/24`, `2001:db8::/32`). */
export function buildIpList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [addr, bits] = cidr.split('/');
    const family = isIP(addr!) === 6 ? 'ipv6' : 'ipv4';
    if (bits) list.addSubnet(addr!, Number(bits), family);
    else list.addAddress(addr!, family);
  }
  return list;
}

export function ipInList(list: BlockList, ip: string | null | undefined): boolean {
  const normalized = normalizeIp(ip);
  if (!isIP(normalized)) return false;
  return list.check(normalized, isIP(normalized) === 6 ? 'ipv6' : 'ipv4');
}
