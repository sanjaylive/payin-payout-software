import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';
import { amountSchema } from './merchant';

/**
 * Risk rule configuration (docs/RISK.md). Params are stored as validated here (money as rupee
 * strings, counts and windows as integers — no floats) and re-parsed on every evaluation.
 */
export const RISK_RULE_TYPES = ['VELOCITY', 'AMOUNT_ANOMALY', 'NEW_MERCHANT_VOLUME', 'BENEFICIARY_FAN_IN', 'VOLUME_SPIKE', 'FAILED_ATTEMPTS', 'SHARED_BANK_ACCOUNT'] as const;
export type RiskRuleTypeValue = (typeof RISK_RULE_TYPES)[number];
export const RISK_ACTIONS = ['ALLOW', 'BLOCK', 'MANUAL_REVIEW', 'HOLD_SETTLEMENT', 'DISABLE_PAYIN', 'DISABLE_PAYOUT'] as const;
export type RiskActionValue = (typeof RISK_ACTIONS)[number];
export type RiskServiceValue = 'PAYIN' | 'PAYOUT';

/** Evaluated inline while the request is in progress. */
export const SYNC_RULE_TYPES: readonly RiskRuleTypeValue[] = ['VELOCITY', 'AMOUNT_ANOMALY', 'NEW_MERCHANT_VOLUME', 'BENEFICIARY_FAN_IN'];
/** Evaluated by the background sweep. */
export const ASYNC_RULE_TYPES: readonly RiskRuleTypeValue[] = ['VOLUME_SPIKE', 'FAILED_ATTEMPTS', 'SHARED_BANK_ACCOUNT'];

const windowSeconds = z.number().int().min(10).max(86_400);
const positiveAmount = amountSchema.refine((v) => v > 0n, 'Must be greater than zero');

export const riskParamsSchemas = {
  /** More than `max_count` transactions from one merchant within `window_seconds`. */
  VELOCITY: z.strictObject({ window_seconds: windowSeconds, max_count: z.number().int().min(1).max(1_000_000) }),
  /** Amount above `multiplier` × the merchant's average over `lookback_days` (needs `min_sample`
   *  transactions; below that, above the declared maximum ticket size). Amounts under `min_amount` are ignored. */
  AMOUNT_ANOMALY: z.strictObject({
    multiplier: z.number().int().min(2).max(1000),
    lookback_days: z.number().int().min(1).max(90),
    min_sample: z.number().int().min(5).max(100_000),
    min_amount: positiveAmount,
  }),
  /** Merchant approved within `new_merchant_days` whose volume today would exceed `max_daily_amount`. */
  NEW_MERCHANT_VOLUME: z.strictObject({ new_merchant_days: z.number().int().min(1).max(365), max_daily_amount: positiveAmount }),
  /** More than `max_count` payouts (any merchant) to the same bank account or UPI ID within `window_seconds`. */
  BENEFICIARY_FAN_IN: z.strictObject({ window_seconds: windowSeconds, max_count: z.number().int().min(1).max(1_000_000) }),
  /** Last 24h volume above `multiplier` × the daily average of the previous `baseline_days` (and at least `min_amount`). */
  VOLUME_SPIKE: z.strictObject({ multiplier: z.number().int().min(2).max(1000), baseline_days: z.number().int().min(3).max(60), min_amount: positiveAmount }),
  /** At least `min_failed` failures and `failure_rate_percent`% failure rate within `window_minutes`. */
  FAILED_ATTEMPTS: z.strictObject({
    window_minutes: z.number().int().min(5).max(1440),
    min_failed: z.number().int().min(1).max(1_000_000),
    failure_rate_percent: z.number().int().min(1).max(100),
  }),
  /** One bank account paid by at least `min_merchants` different merchants within `lookback_days`. */
  SHARED_BANK_ACCOUNT: z.strictObject({ lookback_days: z.number().int().min(1).max(90), min_merchants: z.number().int().min(2).max(1000) }),
} as const satisfies Record<RiskRuleTypeValue, z.ZodType>;

export type RiskParams<T extends RiskRuleTypeValue> = z.output<(typeof riskParamsSchemas)[T]>;

/** Which actions make sense for a rule type and service (BLOCK only exists inline, etc.). */
export function allowedRiskActions(type: RiskRuleTypeValue, service: RiskServiceValue): RiskActionValue[] {
  if (type === 'SHARED_BANK_ACCOUNT') return ['ALLOW', 'MANUAL_REVIEW'];
  const disable: RiskActionValue = service === 'PAYIN' ? 'DISABLE_PAYIN' : 'DISABLE_PAYOUT';
  const base: RiskActionValue[] = ['ALLOW', 'MANUAL_REVIEW', 'HOLD_SETTLEMENT', disable];
  return SYNC_RULE_TYPES.includes(type) ? ['BLOCK', ...base] : base;
}

/** Which services a rule type can watch. */
export function allowedRiskServices(type: RiskRuleTypeValue): RiskServiceValue[] {
  return type === 'BENEFICIARY_FAN_IN' || type === 'SHARED_BANK_ACCOUNT' ? ['PAYOUT'] : ['PAYIN', 'PAYOUT'];
}

const ruleBase = {
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).optional(),
  action: z.enum(RISK_ACTIONS),
  mode: z.enum(['ENFORCE', 'MONITOR']).default('MONITOR'),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(100),
};

export const createRiskRuleSchema = z
  .strictObject({
    code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,59}$/, 'Use 3–60 characters A–Z, 0–9 and _ (starting with a letter)'),
    type: z.enum(RISK_RULE_TYPES),
    service: z.enum(['PAYIN', 'PAYOUT']),
    params: z.record(z.string(), z.unknown()),
    ...ruleBase,
  })
  .superRefine((r, ctx) => checkRule(r.type, r.service, r.action, r.params, ctx));

export const updateRiskRuleSchema = z.strictObject({
  name: ruleBase.name.optional(),
  description: ruleBase.description,
  action: ruleBase.action.optional(),
  mode: z.enum(['ENFORCE', 'MONITOR']).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(5).max(300),
});

/** Shared by create and update (update re-checks against the stored type/service). */
export function checkRule(type: RiskRuleTypeValue, service: RiskServiceValue, action: RiskActionValue, params: unknown, ctx: z.RefinementCtx) {
  if (!allowedRiskServices(type).includes(service)) ctx.addIssue({ code: 'custom', path: ['service'], message: `${type} rules watch ${allowedRiskServices(type).join(' or ')} only` });
  if (!allowedRiskActions(type, service).includes(action)) ctx.addIssue({ code: 'custom', path: ['action'], message: `${type} rules support ${allowedRiskActions(type, service).join(', ')}` });
  const parsed = riskParamsSchemas[type].safeParse(params);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: ['params', ...issue.path.map(String)], message: issue.message });
}

export const listRiskEventsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['RECORDED', 'OPEN', 'CLEARED', 'CONFIRMED']).optional(),
  merchant_id: idSchema('org').optional(),
  rule_id: idSchema('rrl').optional(),
  subject_id: z.string().trim().max(80).optional(),
  enforced: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const resolveRiskEventSchema = z.strictObject({
  /** CLEAR = false positive (lift actions, release a held payout); CONFIRM = genuine (keep actions, reject a held payout). */
  decision: z.enum(['CLEAR', 'CONFIRM']),
  note: z.string().trim().min(5).max(500),
});

export const liftRiskActionSchema = z.strictObject({ reason: z.string().trim().min(5).max(300) });

export const listRiskActionsQuerySchema = z.strictObject({
  active: z.enum(['true', 'false']).transform((v) => v === 'true').default(true),
  merchant_id: idSchema('org').optional(),
});
