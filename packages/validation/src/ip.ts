/**
 * IP address parsing without Node built-ins: this package is bundled into the browser too, so it
 * must never import `node:*` (the dashboard login crashed when it did). Matches `net.isIP()`
 * semantics for the forms we accept (verified against it in ip.spec.ts): no zone ids, no leading
 * zeros in IPv4 octets.
 */
const V4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const V4 = new RegExp(`^${V4_OCTET}(\\.${V4_OCTET}){3}$`);
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

export function isIPv4(v: string): boolean {
  return V4.test(v);
}

export function isIPv6(v: string): boolean {
  if (!v.includes(':')) return false;
  const halves = v.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const all = [...head, ...tail];
  // An embedded IPv4 address (e.g. ::ffff:192.0.2.1) may only be the last part and counts as 2 groups.
  let slots = all.length;
  // It must end the address: the last group of the tail (or of the whole address without '::').
  const finalSegment = halves.length === 2 ? tail : head;
  const last = finalSegment[finalSegment.length - 1];
  if (all.slice(0, -1).some((g) => g.includes('.'))) return false;
  if (last !== undefined && last.includes('.')) {
    if (!isIPv4(last)) return false;
    all.pop();
    slots += 1;
  } else if (all.some((g) => g.includes('.'))) {
    return false;
  }
  if (!all.every((g) => HEX_GROUP.test(g))) return false;
  return halves.length === 2 ? slots <= 7 : slots === 8;
}

/** 4, 6 or 0 — same contract as `net.isIP`. */
export function ipFamily(v: string): 0 | 4 | 6 {
  if (isIPv4(v)) return 4;
  if (isIPv6(v)) return 6;
  return 0;
}
