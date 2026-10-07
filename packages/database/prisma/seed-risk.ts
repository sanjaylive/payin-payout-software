import { newId } from '@pay2all/auth';
import type { Prisma, PrismaClient } from '../src/index';

/**
 * Starter risk rules (docs/RISK.md §7). All start in MONITOR mode: they record what they would have
 * done without blocking or holding anything, so thresholds can be tuned on real traffic before a
 * risk officer switches a rule to ENFORCE. Existing rules are never overwritten.
 */
export const STARTER_RISK_RULES: Array<Omit<Prisma.RiskRuleCreateInput, 'id'>> = [
  {
    code: 'PAYIN_VELOCITY_1M',
    name: 'Payin velocity (per minute)',
    description: 'More than 300 payins from one merchant in 60 seconds.',
    type: 'VELOCITY', service: 'PAYIN', params: { window_seconds: 60, max_count: 300 }, action: 'MANUAL_REVIEW', priority: 10,
  },
  {
    code: 'PAYOUT_VELOCITY_1M',
    name: 'Payout velocity (per minute)',
    description: 'More than 120 payouts from one merchant in 60 seconds.',
    type: 'VELOCITY', service: 'PAYOUT', params: { window_seconds: 60, max_count: 120 }, action: 'MANUAL_REVIEW', priority: 10,
  },
  {
    code: 'PAYIN_AMOUNT_ANOMALY',
    name: 'Unusual payin amount',
    description: 'Payin above 20× the merchant’s 30-day average (or above the declared maximum ticket for new merchants).',
    type: 'AMOUNT_ANOMALY', service: 'PAYIN', params: { multiplier: 20, lookback_days: 30, min_sample: 50, min_amount: '10000.00' }, action: 'HOLD_SETTLEMENT', priority: 20,
  },
  {
    code: 'PAYOUT_AMOUNT_ANOMALY',
    name: 'Unusual payout amount',
    description: 'Payout above 10× the merchant’s 30-day average (or above the declared maximum ticket).',
    type: 'AMOUNT_ANOMALY', service: 'PAYOUT', params: { multiplier: 10, lookback_days: 30, min_sample: 30, min_amount: '25000.00' }, action: 'MANUAL_REVIEW', priority: 20,
  },
  {
    code: 'NEW_MERCHANT_PAYIN_VOLUME',
    name: 'New merchant payin volume',
    description: 'Merchant approved in the last 30 days collecting more than ₹10 lakh in a day.',
    type: 'NEW_MERCHANT_VOLUME', service: 'PAYIN', params: { new_merchant_days: 30, max_daily_amount: '1000000.00' }, action: 'HOLD_SETTLEMENT', priority: 30,
  },
  {
    code: 'NEW_MERCHANT_PAYOUT_VOLUME',
    name: 'New merchant payout volume',
    description: 'Merchant approved in the last 30 days paying out more than ₹5 lakh in a day.',
    type: 'NEW_MERCHANT_VOLUME', service: 'PAYOUT', params: { new_merchant_days: 30, max_daily_amount: '500000.00' }, action: 'MANUAL_REVIEW', priority: 30,
  },
  {
    code: 'PAYOUT_BENEFICIARY_FAN_IN',
    name: 'Many payouts to one beneficiary',
    description: 'More than 20 payouts (any merchant) to the same account or UPI ID in an hour.',
    type: 'BENEFICIARY_FAN_IN', service: 'PAYOUT', params: { window_seconds: 3600, max_count: 20 }, action: 'MANUAL_REVIEW', priority: 15,
  },
  {
    code: 'PAYIN_VOLUME_SPIKE',
    name: 'Payin volume spike',
    description: 'Last 24h payins above 5× the 14-day daily average (and at least ₹5 lakh).',
    type: 'VOLUME_SPIKE', service: 'PAYIN', params: { multiplier: 5, baseline_days: 14, min_amount: '500000.00' }, action: 'HOLD_SETTLEMENT', priority: 40,
  },
  {
    code: 'PAYOUT_VOLUME_SPIKE',
    name: 'Payout volume spike',
    description: 'Last 24h payouts above 5× the 14-day daily average (and at least ₹5 lakh).',
    type: 'VOLUME_SPIKE', service: 'PAYOUT', params: { multiplier: 5, baseline_days: 14, min_amount: '500000.00' }, action: 'MANUAL_REVIEW', priority: 40,
  },
  {
    code: 'PAYIN_FAILED_ATTEMPTS',
    name: 'Payin failure burst',
    description: 'At least 50 failed payins at a 60% failure rate within 15 minutes.',
    type: 'FAILED_ATTEMPTS', service: 'PAYIN', params: { window_minutes: 15, min_failed: 50, failure_rate_percent: 60 }, action: 'MANUAL_REVIEW', priority: 50,
  },
  {
    code: 'PAYOUT_FAILED_ATTEMPTS',
    name: 'Payout failure burst',
    description: 'At least 20 failed payouts at a 50% failure rate within 30 minutes.',
    type: 'FAILED_ATTEMPTS', service: 'PAYOUT', params: { window_minutes: 30, min_failed: 20, failure_rate_percent: 50 }, action: 'MANUAL_REVIEW', priority: 50,
  },
  {
    code: 'SHARED_BANK_ACCOUNT',
    name: 'Bank account paid by many merchants',
    description: 'One bank account receiving payouts from 3 or more merchants within 7 days.',
    type: 'SHARED_BANK_ACCOUNT', service: 'PAYOUT', params: { lookback_days: 7, min_merchants: 3 }, action: 'MANUAL_REVIEW', priority: 60,
  },
];

export async function seedRiskRules(db: PrismaClient): Promise<number> {
  let created = 0;
  for (const r of STARTER_RISK_RULES) {
    const exists = await db.riskRule.findUnique({ where: { code: r.code }, select: { id: true } });
    if (exists) continue;
    await db.riskRule.create({ data: { ...r, id: newId('riskRule'), mode: 'MONITOR', enabled: true } });
    created++;
  }
  return created;
}
