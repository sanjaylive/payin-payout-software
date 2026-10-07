import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ipAllowlistEntrySchema } from './api-keys';
import { ipFamily } from './ip';

const CASES = [
  '203.0.113.10', '0.0.0.0', '255.255.255.255', '256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.04', '1..2.3', ' 1.2.3.4', '1.2.3.4 ', 'a.b.c.d',
  '::', '::1', '2001:db8::1', '2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8:0:0:0:0:2:1', 'fe80::1ff:fe23:4567:890a',
  '::ffff:192.0.2.128', '64:ff9b::192.0.2.33', '2001:db8::1::2', '2001:db8:::1', '12345::', ':1', '1:', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9',
  '1:2:3:4:5:6:7::', '::1:2:3:4:5:6:7', '1:2:3:4:5:6::7:8', 'g::1', '::ffff:999.0.0.1', '1.2.3.4::', '',
];

describe('ipFamily', () => {
  it.each(CASES)('agrees with net.isIP for %j', (v) => {
    expect(ipFamily(v)).toBe(isIP(v));
  });

  it('deliberately rejects IPv6 zone ids (meaningless in an allowlist), which net.isIP accepts', () => {
    expect(isIP('fe80::1%eth0')).toBe(6);
    expect(ipFamily('fe80::1%eth0')).toBe(0);
  });
});

describe('ipAllowlistEntrySchema', () => {
  it('accepts addresses and CIDRs with sensible prefixes only', () => {
    const ok = (cidr: string) => ipAllowlistEntrySchema.safeParse({ cidr }).success;
    expect(ok('203.0.113.10')).toBe(true);
    expect(ok('203.0.113.0/24')).toBe(true);
    expect(ok('2001:db8::/48')).toBe(true);
    expect(ok('10.0.0.0/7')).toBe(false);
    expect(ok('2001:db8::/16')).toBe(false);
    expect(ok('300.1.1.1')).toBe(false);
    expect(ok('1.2.3.4/33')).toBe(false);
  });
});
