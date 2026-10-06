import { clamp, MoneyError, percentOf } from './money';

/**
 * Fee calculation (pure). Plan resolution and snapshots live in the API; this module only answers
 * "which rule applies, and what does it charge" — exactly, with HALF_UP rounding once per component.
 */

export type ChargeType = 'FLAT' | 'PERCENTAGE' | 'PERCENTAGE_WITH_MIN_MAX';

export interface PricingRuleLike {
  id: string;
  service: string;
  method: string | null;
  providerId: string | null;
  minAmountMinor: bigint | null;
  maxAmountMinor: bigint | null;
  chargeType: ChargeType;
  rateMicros: bigint | null;
  flatMinor: bigint | null;
  minFeeMinor: bigint | null;
  maxFeeMinor: bigint | null;
}

export interface PricingContext {
  service: string;
  method: string;
  providerId: string | null;
  amountMinor: bigint;
}

/**
 * Most specific matching rule wins: method+provider > method > provider > any; among equals the
 * narrowest amount slab wins. Returns null when nothing matches.
 */
export function selectRule<R extends PricingRuleLike>(rules: R[], ctx: PricingContext): R | null {
  const matches = rules.filter(
    (r) =>
      r.service === ctx.service &&
      (r.method === null || r.method === ctx.method) &&
      (r.providerId === null || r.providerId === ctx.providerId) &&
      (r.minAmountMinor === null || ctx.amountMinor >= r.minAmountMinor) &&
      (r.maxAmountMinor === null || ctx.amountMinor <= r.maxAmountMinor),
  );
  const score = (r: R) => (r.method ? 2 : 0) + (r.providerId ? 1 : 0);
  const width = (r: R) => (r.maxAmountMinor ?? 10n ** 18n) - (r.minAmountMinor ?? 0n);
  matches.sort((a, b) => score(b) - score(a) || (width(a) < width(b) ? -1 : width(a) > width(b) ? 1 : 0));
  return matches[0] ?? null;
}

export function computeFee(rule: PricingRuleLike, amountMinor: bigint): bigint {
  switch (rule.chargeType) {
    case 'FLAT':
      if (rule.flatMinor === null) throw new MoneyError('FLAT rule without flat amount');
      return rule.flatMinor;
    case 'PERCENTAGE':
      if (rule.rateMicros === null) throw new MoneyError('PERCENTAGE rule without rate');
      return percentOf(amountMinor, rule.rateMicros);
    case 'PERCENTAGE_WITH_MIN_MAX':
      if (rule.rateMicros === null) throw new MoneyError('PERCENTAGE_WITH_MIN_MAX rule without rate');
      return clamp(percentOf(amountMinor, rule.rateMicros), rule.minFeeMinor, rule.maxFeeMinor);
  }
}
