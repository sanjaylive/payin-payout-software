import { minorToMajorString } from '@pay2all/ledger';
import type { RiskParams } from '@pay2all/validation';

/**
 * Pure rule logic (docs/RISK.md §3). Each evaluator gets the rule's parsed params plus the observed
 * figures and returns either null (no hit) or a hit with a human reason and machine evidence. The
 * evidence is stored verbatim on the risk event, so it must say exactly why the rule fired:
 * observed values, thresholds and window. Money in evidence is a rupee string, never a float.
 */
export interface RiskHit {
  reason: string;
  evidence: Record<string, string | number | boolean | null | string[]>;
}

const rupees = (minor: bigint) => minorToMajorString(minor);

export function evaluateVelocity(p: RiskParams<'VELOCITY'>, observed: { count: number }): RiskHit | null {
  if (observed.count <= p.max_count) return null;
  return {
    reason: `${observed.count} transactions in ${p.window_seconds}s (limit ${p.max_count})`,
    evidence: { observed_count: observed.count, max_count: p.max_count, window_seconds: p.window_seconds },
  };
}

export function evaluateAmountAnomaly(
  p: RiskParams<'AMOUNT_ANOMALY'>,
  observed: { amountMinor: bigint; sampleCount: number; sampleSumMinor: bigint; declaredMaxTicketMinor: bigint | null },
): RiskHit | null {
  if (observed.amountMinor < p.min_amount) return null;
  if (observed.sampleCount >= p.min_sample) {
    const averageMinor = observed.sampleSumMinor / BigInt(observed.sampleCount);
    const thresholdMinor = averageMinor * BigInt(p.multiplier);
    if (averageMinor === 0n || observed.amountMinor <= thresholdMinor) return null;
    return {
      reason: `Amount ₹${rupees(observed.amountMinor)} is more than ${p.multiplier}× the ${p.lookback_days}-day average of ₹${rupees(averageMinor)}`,
      evidence: {
        basis: 'trailing_average',
        amount: rupees(observed.amountMinor),
        average: rupees(averageMinor),
        threshold: rupees(thresholdMinor),
        multiplier: p.multiplier,
        sample_count: observed.sampleCount,
        lookback_days: p.lookback_days,
      },
    };
  }
  // Too little history: compare with what the merchant declared at onboarding instead.
  if (observed.declaredMaxTicketMinor === null || observed.amountMinor <= observed.declaredMaxTicketMinor) return null;
  return {
    reason: `Amount ₹${rupees(observed.amountMinor)} exceeds the declared maximum ticket of ₹${rupees(observed.declaredMaxTicketMinor)} (only ${observed.sampleCount} past transactions)`,
    evidence: {
      basis: 'declared_max_ticket',
      amount: rupees(observed.amountMinor),
      declared_max_ticket: rupees(observed.declaredMaxTicketMinor),
      sample_count: observed.sampleCount,
      min_sample: p.min_sample,
    },
  };
}

export function evaluateNewMerchantVolume(
  p: RiskParams<'NEW_MERCHANT_VOLUME'>,
  observed: { approvedDaysAgo: number | null; todayVolumeMinor: bigint; amountMinor: bigint },
): RiskHit | null {
  if (observed.approvedDaysAgo === null || observed.approvedDaysAgo > p.new_merchant_days) return null;
  const projected = observed.todayVolumeMinor + observed.amountMinor;
  if (projected <= p.max_daily_amount) return null;
  return {
    reason: `Merchant approved ${observed.approvedDaysAgo} day(s) ago would reach ₹${rupees(projected)} today (limit for new merchants ₹${rupees(p.max_daily_amount)})`,
    evidence: {
      approved_days_ago: observed.approvedDaysAgo,
      new_merchant_days: p.new_merchant_days,
      volume_today: rupees(observed.todayVolumeMinor),
      amount: rupees(observed.amountMinor),
      projected_volume: rupees(projected),
      max_daily_amount: rupees(p.max_daily_amount),
    },
  };
}

export function evaluateBeneficiaryFanIn(p: RiskParams<'BENEFICIARY_FAN_IN'>, observed: { count: number; destination: 'BANK_ACCOUNT' | 'UPI' }): RiskHit | null {
  if (observed.count <= p.max_count) return null;
  return {
    reason: `${observed.count} payouts to the same ${observed.destination === 'UPI' ? 'UPI ID' : 'bank account'} in ${p.window_seconds}s (limit ${p.max_count})`,
    evidence: { observed_count: observed.count, max_count: p.max_count, window_seconds: p.window_seconds, destination: observed.destination },
  };
}

export function evaluateVolumeSpike(p: RiskParams<'VOLUME_SPIKE'>, observed: { last24hMinor: bigint; baselineTotalMinor: bigint }): RiskHit | null {
  if (observed.last24hMinor < p.min_amount) return null;
  const dailyAverage = observed.baselineTotalMinor / BigInt(p.baseline_days);
  const threshold = dailyAverage * BigInt(p.multiplier);
  if (observed.last24hMinor <= threshold) return null;
  return {
    reason:
      dailyAverage === 0n
        ? `₹${rupees(observed.last24hMinor)} in the last 24h with no volume in the previous ${p.baseline_days} days`
        : `₹${rupees(observed.last24hMinor)} in the last 24h is more than ${p.multiplier}× the ${p.baseline_days}-day daily average of ₹${rupees(dailyAverage)}`,
    evidence: {
      last_24h: rupees(observed.last24hMinor),
      baseline_daily_average: rupees(dailyAverage),
      threshold: rupees(threshold),
      multiplier: p.multiplier,
      baseline_days: p.baseline_days,
      min_amount: rupees(p.min_amount),
    },
  };
}

export function evaluateFailedAttempts(p: RiskParams<'FAILED_ATTEMPTS'>, observed: { failed: number; total: number }): RiskHit | null {
  if (observed.total === 0 || observed.failed < p.min_failed) return null;
  // Integer comparison: failed/total >= rate%  ⇔  failed*100 >= rate*total.
  if (observed.failed * 100 < p.failure_rate_percent * observed.total) return null;
  const ratePercent = Math.floor((observed.failed * 100) / observed.total);
  return {
    reason: `${observed.failed} of ${observed.total} attempts failed (${ratePercent}%) in ${p.window_minutes} min`,
    evidence: {
      failed: observed.failed,
      total: observed.total,
      failure_rate_percent: ratePercent,
      threshold_percent: p.failure_rate_percent,
      min_failed: p.min_failed,
      window_minutes: p.window_minutes,
    },
  };
}

export function evaluateSharedBankAccount(p: RiskParams<'SHARED_BANK_ACCOUNT'>, observed: { merchantIds: string[]; payoutCount: number }): RiskHit | null {
  if (observed.merchantIds.length < p.min_merchants) return null;
  return {
    reason: `${observed.merchantIds.length} merchants paid the same bank account in ${p.lookback_days} days (${observed.payoutCount} payouts)`,
    evidence: {
      merchant_count: observed.merchantIds.length,
      min_merchants: p.min_merchants,
      payout_count: observed.payoutCount,
      lookback_days: p.lookback_days,
      merchant_ids: observed.merchantIds.slice(0, 50),
    },
  };
}

export type RiskDecision = 'ALLOW' | 'REVIEW' | 'BLOCK';

/**
 * Combine enforced hits into one decision for the request in progress. BLOCK beats REVIEW; disabling
 * the very service being used blocks this request too. HOLD_SETTLEMENT and ALLOW let it proceed.
 */
export function decide(enforcedActions: readonly string[], service: 'PAYIN' | 'PAYOUT'): RiskDecision {
  const disableSelf = service === 'PAYIN' ? 'DISABLE_PAYIN' : 'DISABLE_PAYOUT';
  if (enforcedActions.some((a) => a === 'BLOCK' || a === disableSelf)) return 'BLOCK';
  if (enforcedActions.includes('MANUAL_REVIEW')) return 'REVIEW';
  return 'ALLOW';
}
