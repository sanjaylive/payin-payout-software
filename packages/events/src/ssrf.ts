import { isIP } from 'node:net';

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/**
 * True for addresses a merchant webhook must never reach: loopback, private, link-local (incl. the
 * cloud metadata endpoint 169.254.169.254), CGNAT, multicast, reserved and documentation ranges —
 * for IPv4, IPv6 and IPv4-mapped IPv6.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const n = v4ToInt(address);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (family === 6) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isBlockedAddress(mapped[1]!);
    if (a === '::' || a === '::1') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 /* fc00::/7 ULA */ || (first & 0xffc0) === 0xfe80 /* link-local */ || (first & 0xff00) === 0xff00 /* multicast */ || a.startsWith('2001:db8');
  }
  return true; // not an IP literal → caller must resolve first
}
