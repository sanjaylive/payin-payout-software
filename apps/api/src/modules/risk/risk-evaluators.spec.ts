import { riskParamsSchemas } from '@pay2all/validation';
import { describe, expect, it } from 'vitest';
import {
  decide,
  evaluateAmountAnomaly,
  evaluateBeneficiaryFanIn,
  evaluateFailedAttempts,
  evaluateNewMerchantVolume,
  evaluateSharedBankAccount,
  evaluateVelocity,
  evaluateVolumeSpike,
} from './risk-evaluators';

const parse = <T extends keyof typeof riskParamsSchemas>(type: T, raw: unknown) => riskParamsSchemas[type].parse(raw) as never;

describe('risk evaluators', () => {
  it('velocity fires only above the limit and records the window', () => {
    const p = parse('VELOCITY', { window_seconds: 60, max_count: 5 });
    expect(evaluateVelocity(p, { count: 5 })).toBeNull();
    expect(evaluateVelocity(p, { count: 6 })).toEqual({
      reason: '6 transactions in 60s (limit 5)',
      evidence: { observed_count: 6, max_count: 5, window_seconds: 60 },
    });
  });

  it('amount anomaly compares with the trailing average using integer paise', () => {
    const p = parse('AMOUNT_ANOMALY', { multiplier: 10, lookback_days: 30, min_sample: 5, min_amount: '1000.00' });
    // average ₹200.00 → threshold ₹2,000.00
    const base = { sampleCount: 10, sampleSumMinor: 200_000n, declaredMaxTicketMinor: null };
    expect(evaluateAmountAnomaly(p, { ...base, amountMinor: 200_000n })).toBeNull(); // exactly 10× is not "more than"
    const hit = evaluateAmountAnomaly(p, { ...base, amountMinor: 200_001n });
    expect(hit?.evidence).toMatchObject({ basis: 'trailing_average', average: '200.00', threshold: '2000.00', amount: '2000.01' });
    // below min_amount: ignored however unusual
    expect(evaluateAmountAnomaly(p, { ...base, sampleSumMinor: 10n, amountMinor: 99_999n })).toBeNull();
  });

  it('amount anomaly falls back to the declared maximum ticket when history is thin', () => {
    const p = parse('AMOUNT_ANOMALY', { multiplier: 10, lookback_days: 30, min_sample: 50, min_amount: '100.00' });
    expect(evaluateAmountAnomaly(p, { amountMinor: 600_000n, sampleCount: 3, sampleSumMinor: 30_000n, declaredMaxTicketMinor: null })).toBeNull();
    expect(evaluateAmountAnomaly(p, { amountMinor: 500_000n, sampleCount: 3, sampleSumMinor: 30_000n, declaredMaxTicketMinor: 500_000n })).toBeNull();
    expect(evaluateAmountAnomaly(p, { amountMinor: 500_001n, sampleCount: 3, sampleSumMinor: 30_000n, declaredMaxTicketMinor: 500_000n })?.evidence).toMatchObject({
      basis: 'declared_max_ticket',
      declared_max_ticket: '5000.00',
      sample_count: 3,
    });
  });

  it('new-merchant volume applies only inside the new-merchant window and counts this transaction', () => {
    const p = parse('NEW_MERCHANT_VOLUME', { new_merchant_days: 30, max_daily_amount: '1000.00' });
    expect(evaluateNewMerchantVolume(p, { approvedDaysAgo: 31, todayVolumeMinor: 10_000_000n, amountMinor: 1n })).toBeNull();
    expect(evaluateNewMerchantVolume(p, { approvedDaysAgo: 2, todayVolumeMinor: 90_000n, amountMinor: 10_000n })).toBeNull(); // = ₹1,000.00
    expect(evaluateNewMerchantVolume(p, { approvedDaysAgo: 2, todayVolumeMinor: 90_000n, amountMinor: 10_001n })?.evidence).toMatchObject({ projected_volume: '1000.01' });
  });

  it('fan-in names the destination kind', () => {
    const p = parse('BENEFICIARY_FAN_IN', { window_seconds: 3600, max_count: 3 });
    expect(evaluateBeneficiaryFanIn(p, { count: 3, destination: 'UPI' })).toBeNull();
    expect(evaluateBeneficiaryFanIn(p, { count: 4, destination: 'UPI' })?.reason).toContain('UPI ID');
  });

  it('volume spike: baseline average × multiplier, with a floor, and no-history spikes', () => {
    const p = parse('VOLUME_SPIKE', { multiplier: 5, baseline_days: 10, min_amount: '1000.00' });
    // baseline ₹10,000 over 10 days = ₹1,000/day → threshold ₹5,000
    expect(evaluateVolumeSpike(p, { last24hMinor: 500_000n, baselineTotalMinor: 1_000_000n })).toBeNull();
    expect(evaluateVolumeSpike(p, { last24hMinor: 500_001n, baselineTotalMinor: 1_000_000n })?.evidence).toMatchObject({ baseline_daily_average: '1000.00', threshold: '5000.00' });
    expect(evaluateVolumeSpike(p, { last24hMinor: 99_999n, baselineTotalMinor: 0n })).toBeNull(); // under the floor
    expect(evaluateVolumeSpike(p, { last24hMinor: 100_000n, baselineTotalMinor: 0n })?.reason).toContain('no volume');
  });

  it('failed attempts needs both the count and the rate (integer arithmetic)', () => {
    const p = parse('FAILED_ATTEMPTS', { window_minutes: 15, min_failed: 10, failure_rate_percent: 60 });
    expect(evaluateFailedAttempts(p, { failed: 9, total: 9 })).toBeNull();
    expect(evaluateFailedAttempts(p, { failed: 59, total: 100 })).toBeNull();
    expect(evaluateFailedAttempts(p, { failed: 60, total: 100 })?.evidence).toMatchObject({ failure_rate_percent: 60 });
  });

  it('shared bank account caps the stored merchant list', () => {
    const p = parse('SHARED_BANK_ACCOUNT', { lookback_days: 7, min_merchants: 3 });
    expect(evaluateSharedBankAccount(p, { merchantIds: ['a', 'b'], payoutCount: 9 })).toBeNull();
    const ids = Array.from({ length: 60 }, (_, i) => `org_${i}`);
    expect((evaluateSharedBankAccount(p, { merchantIds: ids, payoutCount: 60 })?.evidence.merchant_ids as string[]).length).toBe(50);
  });

  it('decide: BLOCK and disabling the service in use block; review holds; holds proceed', () => {
    expect(decide([], 'PAYIN')).toBe('ALLOW');
    expect(decide(['HOLD_SETTLEMENT', 'ALLOW'], 'PAYIN')).toBe('ALLOW');
    expect(decide(['MANUAL_REVIEW', 'HOLD_SETTLEMENT'], 'PAYOUT')).toBe('REVIEW');
    expect(decide(['MANUAL_REVIEW', 'BLOCK'], 'PAYOUT')).toBe('BLOCK');
    expect(decide(['DISABLE_PAYOUT'], 'PAYOUT')).toBe('BLOCK');
    expect(decide(['DISABLE_PAYOUT'], 'PAYIN')).toBe('ALLOW');
  });
});
