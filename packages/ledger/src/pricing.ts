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

// ---- Schemes (docs/PRICING_SCHEMES.md) -----------------------------------------------------------

export interface SchemeRateLike {
  id: string;
  providerId: number;
  minAmountMinor: bigint;
  maxAmountMinor: bigint | null;
  valueType: 'FLAT' | 'PERCENT';
  /** Signed: negative = charge to the merchant, positive = commission to the merchant. */
  value: bigint;
}

/** The slab containing the amount (slabs within a provider never overlap). */
export function selectSchemeRate<R extends SchemeRateLike>(rates: R[], providerId: number, amountMinor: bigint): R | null {
  return rates.find((r) => r.providerId === providerId && amountMinor >= r.minAmountMinor && (r.maxAmountMinor === null || amountMinor <= r.maxAmountMinor)) ?? null;
}

/** A scheme value applied to an amount: exactly one of fee / commission is non-zero (or neither). */
export function schemeCharge(rate: SchemeRateLike, amountMinor: bigint): { feeMinor: bigint; commissionMinor: bigint } {
  const magnitude = rate.value < 0n ? -rate.value : rate.value;
  const v = rate.valueType === 'FLAT' ? magnitude : percentOf(amountMinor, magnitude);
  return rate.value < 0n ? { feeMinor: v, commissionMinor: 0n } : { feeMinor: 0n, commissionMinor: v };
}

/** Slabs for one provider must not overlap. Returns the first overlapping pair, or null. */
export function findSlabOverlap<R extends Pick<SchemeRateLike, 'providerId' | 'minAmountMinor' | 'maxAmountMinor'>>(rates: R[]): [R, R] | null {
  const byProvider = new Map<number, R[]>();
  for (const r of rates) byProvider.set(r.providerId, [...(byProvider.get(r.providerId) ?? []), r]);
  for (const list of byProvider.values()) {
    const sorted = [...list].sort((a, b) => (a.minAmountMinor < b.minAmountMinor ? -1 : a.minAmountMinor > b.minAmountMinor ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      if (prev.maxAmountMinor === null || sorted[i]!.minAmountMinor <= prev.maxAmountMinor) return [prev, sorted[i]!];
    }
  }
  return null;
}

/**
 * Commission claw-back for a refund, pro rata to the cumulative refunded amount, so that a full
 * refund takes back exactly the commission credited (no rounding drift across partial refunds).
 */
export function commissionClawback(commissionMinor: bigint, paymentAmountMinor: bigint, refundedBeforeMinor: bigint, refundMinor: bigint, clawedBeforeMinor: bigint): bigint {
  if (commissionMinor === 0n) return 0n;
  const cumulative = refundedBeforeMinor + refundMinor;
  const target = cumulative >= paymentAmountMinor ? commissionMinor : (commissionMinor * cumulative) / paymentAmountMinor;
  return target > clawedBeforeMinor ? target - clawedBeforeMinor : 0n;
}
