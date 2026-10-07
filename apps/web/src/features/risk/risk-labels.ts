import type { RiskAction, RiskRuleType } from '@/lib/api/types';

export const RULE_TYPE_LABELS: Record<RiskRuleType, string> = {
  VELOCITY: 'Transaction velocity',
  AMOUNT_ANOMALY: 'Unusual amount',
  NEW_MERCHANT_VOLUME: 'New merchant volume',
  BENEFICIARY_FAN_IN: 'Many payouts to one beneficiary',
  VOLUME_SPIKE: 'Volume spike',
  FAILED_ATTEMPTS: 'Failed attempts',
  SHARED_BANK_ACCOUNT: 'Bank account shared across merchants',
};

/** Inline rules run while the request is in progress; the rest run in the 5-minute sweep. */
export const INLINE_TYPES: RiskRuleType[] = ['VELOCITY', 'AMOUNT_ANOMALY', 'NEW_MERCHANT_VOLUME', 'BENEFICIARY_FAN_IN'];

export const ACTION_LABELS: Record<RiskAction, string> = {
  ALLOW: 'Record only',
  BLOCK: 'Block',
  MANUAL_REVIEW: 'Manual review',
  HOLD_SETTLEMENT: 'Hold settlement',
  DISABLE_PAYIN: 'Disable payin',
  DISABLE_PAYOUT: 'Disable payout',
};

export const ACTION_HELP: Record<RiskAction, string> = {
  ALLOW: 'Record an event; take no action.',
  BLOCK: 'Decline the transaction (RISK_BLOCKED).',
  MANUAL_REVIEW: 'Payouts are held (funds reserved) until reviewed; payins proceed and a review case opens.',
  HOLD_SETTLEMENT: 'Place a settlement hold on the merchant until a reviewer clears it.',
  DISABLE_PAYIN: 'Switch the merchant’s payins off until a reviewer clears it.',
  DISABLE_PAYOUT: 'Switch the merchant’s payouts off until a reviewer clears it.',
};

export interface ParamField {
  key: string;
  label: string;
  kind: 'int' | 'money';
  hint?: string;
}

export const PARAM_FIELDS: Record<RiskRuleType, ParamField[]> = {
  VELOCITY: [
    { key: 'window_seconds', label: 'Window (seconds)', kind: 'int' },
    { key: 'max_count', label: 'Max transactions in window', kind: 'int' },
  ],
  AMOUNT_ANOMALY: [
    { key: 'multiplier', label: 'Multiple of average', kind: 'int' },
    { key: 'lookback_days', label: 'Average over (days)', kind: 'int' },
    { key: 'min_sample', label: 'Min. past transactions', kind: 'int', hint: 'Below this, compare with the declared maximum ticket' },
    { key: 'min_amount', label: 'Ignore amounts below (₹)', kind: 'money' },
  ],
  NEW_MERCHANT_VOLUME: [
    { key: 'new_merchant_days', label: 'New for (days after approval)', kind: 'int' },
    { key: 'max_daily_amount', label: 'Max daily volume (₹)', kind: 'money' },
  ],
  BENEFICIARY_FAN_IN: [
    { key: 'window_seconds', label: 'Window (seconds)', kind: 'int' },
    { key: 'max_count', label: 'Max payouts to one destination', kind: 'int' },
  ],
  VOLUME_SPIKE: [
    { key: 'multiplier', label: 'Multiple of daily average', kind: 'int' },
    { key: 'baseline_days', label: 'Baseline (days)', kind: 'int' },
    { key: 'min_amount', label: 'Only above 24h volume (₹)', kind: 'money' },
  ],
  FAILED_ATTEMPTS: [
    { key: 'window_minutes', label: 'Window (minutes)', kind: 'int' },
    { key: 'min_failed', label: 'Min. failures', kind: 'int' },
    { key: 'failure_rate_percent', label: 'Min. failure rate (%)', kind: 'int' },
  ],
  SHARED_BANK_ACCOUNT: [
    { key: 'lookback_days', label: 'Look back (days)', kind: 'int' },
    { key: 'min_merchants', label: 'Min. merchants paying it', kind: 'int' },
  ],
};

/** "max_count 300 · window 60s" style one-liner for tables. */
export function paramsSummary(type: RiskRuleType, params: Record<string, string | number>): string {
  return PARAM_FIELDS[type].map((f) => `${f.label.replace(/ \(.*\)$/, '')}: ${f.kind === 'money' ? `₹${params[f.key]}` : params[f.key]}`).join(' · ');
}

export const EVENT_STATUS_TONE: Record<string, 'warning' | 'success' | 'danger' | 'neutral'> = { OPEN: 'warning', CLEARED: 'success', CONFIRMED: 'danger', RECORDED: 'neutral' };
