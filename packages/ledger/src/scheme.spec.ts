import { describe, expect, it } from 'vitest';
import { parseRateMicros } from './money.js';
import { commissionClawback, findSlabOverlap, type SchemeRateLike, schemeCharge, selectSchemeRate } from './pricing.js';

const rate = (over: Partial<SchemeRateLike>): SchemeRateLike => ({ id: 'r', providerId: 1, minAmountMinor: 100n, maxAmountMinor: null, valueType: 'FLAT', value: -500n, ...over });

describe('schemes', () => {
  it('a negative value is a charge, a positive one a commission, as % or flat', () => {
    expect(schemeCharge(rate({ value: -500n }), 1_000_000n)).toEqual({ feeMinor: 500n, commissionMinor: 0n });
    expect(schemeCharge(rate({ value: 300n }), 1_000_000n)).toEqual({ feeMinor: 0n, commissionMinor: 300n });
    expect(schemeCharge(rate({ valueType: 'PERCENT', value: -parseRateMicros('0.5') }), 100_000n)).toEqual({ feeMinor: 500n, commissionMinor: 0n });
    expect(schemeCharge(rate({ valueType: 'PERCENT', value: parseRateMicros('0.25') }), 100_001n)).toEqual({ feeMinor: 0n, commissionMinor: 250n }); // HALF_UP
    expect(schemeCharge(rate({ value: 0n }), 100n)).toEqual({ feeMinor: 0n, commissionMinor: 0n });
  });

  it('picks the slab containing the amount, inclusive on both ends', () => {
    const rates = [rate({ id: 'a', maxAmountMinor: 100_000n }), rate({ id: 'b', minAmountMinor: 100_001n, maxAmountMinor: 2_500_000n }), rate({ id: 'c', minAmountMinor: 2_500_001n }), rate({ id: 'q', providerId: 2 })];
    expect(selectSchemeRate(rates, 1, 100_000n)?.id).toBe('a');
    expect(selectSchemeRate(rates, 1, 100_001n)?.id).toBe('b');
    expect(selectSchemeRate(rates, 1, 99_000_000n)?.id).toBe('c');
    expect(selectSchemeRate(rates, 1, 99n)).toBeNull();
    expect(selectSchemeRate(rates, 3, 1_000n)).toBeNull();
  });

  it('finds overlapping slabs per provider only', () => {
    expect(findSlabOverlap([rate({ maxAmountMinor: 1000n }), rate({ minAmountMinor: 1001n }), rate({ providerId: 2, minAmountMinor: 0n })])).toBeNull();
    expect(findSlabOverlap([rate({ maxAmountMinor: 1000n }), rate({ minAmountMinor: 1000n })])).not.toBeNull();
    expect(findSlabOverlap([rate({}), rate({ minAmountMinor: 5_000_000n })])).not.toBeNull(); // open-ended first slab
  });

  it('claws back commission pro rata and exactly in full', () => {
    // ₹10.00 commission on ₹1,000; refunds of ₹333.33, ₹333.33, ₹333.34.
    const a = commissionClawback(1000n, 100_000n, 0n, 33_333n, 0n);
    const b = commissionClawback(1000n, 100_000n, 33_333n, 33_333n, a);
    const c = commissionClawback(1000n, 100_000n, 66_666n, 33_334n, a + b);
    expect([a, b, c]).toEqual([333n, 333n, 334n]);
    expect(commissionClawback(0n, 100_000n, 0n, 100_000n, 0n)).toBe(0n);
  });
});
