import { describe, expect, it } from 'vitest';
import { parseRateMicros, taxOn } from './money.js';
import { computeFee, type PricingRuleLike, selectRule } from './pricing.js';

const rule = (id: string, over: Partial<PricingRuleLike>): PricingRuleLike => ({
  id, service: 'PAYIN', method: null, providerId: null, minAmountMinor: null, maxAmountMinor: null, chargeType: 'PERCENTAGE', rateMicros: parseRateMicros('0.18'), flatMinor: null, minFeeMinor: null, maxFeeMinor: null, ...over,
});

describe('pricing', () => {
  it('computes the spec example layers exactly on ₹1,000', () => {
    const amount = 100_000n;
    const provider = computeFee(rule('p', { rateMicros: parseRateMicros('0.10') }), amount);
    const wholesale = computeFee(rule('w', { rateMicros: parseRateMicros('0.14') }), amount);
    const merchant = computeFee(rule('m', { rateMicros: parseRateMicros('0.18') }), amount);
    expect([provider, wholesale, merchant]).toEqual([100n, 140n, 180n]);
    expect(wholesale - provider).toBe(40n); // Pay2All margin 0.04%
    expect(merchant - wholesale).toBe(40n); // reseller margin 0.04%
    expect(taxOn(merchant, parseRateMicros('18'))).toBe(32n);
  });

  it('charges flat payout fees and clamps percentage fees', () => {
    expect(computeFee(rule('f', { service: 'PAYOUT', chargeType: 'FLAT', flatMinor: 500n, rateMicros: null }), 1_000_000n)).toBe(500n);
    const capped = rule('c', { chargeType: 'PERCENTAGE_WITH_MIN_MAX', rateMicros: parseRateMicros('1'), minFeeMinor: 200n, maxFeeMinor: 1_000n });
    expect(computeFee(capped, 5_000n)).toBe(200n);
    expect(computeFee(capped, 50_000n)).toBe(500n);
    expect(computeFee(capped, 5_000_000n)).toBe(1_000n);
  });

  it('selects the most specific rule and the narrowest slab', () => {
    const rules = [
      rule('any', {}),
      rule('qr', { method: 'UPI_QR' }),
      rule('qr-prv', { method: 'UPI_QR', providerId: 'prv_1' }),
      rule('slab-wide', { method: 'UPI_INTENT', maxAmountMinor: 10_000_000n }),
      rule('slab-narrow', { method: 'UPI_INTENT', maxAmountMinor: 200_000n }),
      rule('payout', { service: 'PAYOUT' }),
    ];
    const ctx = { service: 'PAYIN', providerId: 'prv_1', amountMinor: 100_000n };
    expect(selectRule(rules, { ...ctx, method: 'UPI_QR' })?.id).toBe('qr-prv');
    expect(selectRule(rules, { ...ctx, method: 'UPI_QR', providerId: 'prv_2' })?.id).toBe('qr');
    expect(selectRule(rules, { ...ctx, method: 'UPI_INTENT' })?.id).toBe('slab-narrow');
    expect(selectRule(rules, { ...ctx, method: 'UPI_INTENT', amountMinor: 500_000n })?.id).toBe('slab-wide');
    expect(selectRule(rules, { ...ctx, method: 'PAYMENT_LINK' })?.id).toBe('any');
    expect(selectRule([], { ...ctx, method: 'UPI_QR' })).toBeNull();
  });
});
