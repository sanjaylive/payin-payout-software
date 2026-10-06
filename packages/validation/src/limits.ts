import { z } from 'zod';
import { idSchema } from './common';
import { amountSchema } from './merchant';

export const limitLevelSchema = z.enum(['SYSTEM', 'RESELLER', 'MERCHANT']);
export const limitServiceSchema = z.enum(['PAYIN', 'PAYOUT']);

const count = z.number().int().min(0).max(100_000_000);

/** Omitted field = keep current value; null = clear (inherit from the broader level). */
export const upsertLimitSchema = z
  .strictObject({
    level: limitLevelSchema,
    subject_id: idSchema('org').optional(),
    service: limitServiceSchema,
    per_transaction_min: amountSchema.nullable().optional(),
    per_transaction_max: amountSchema.nullable().optional(),
    daily_amount: amountSchema.nullable().optional(),
    daily_count: count.nullable().optional(),
    monthly_amount: amountSchema.nullable().optional(),
    monthly_count: count.nullable().optional(),
    reason: z.string().trim().min(5).max(500),
  })
  .refine((v) => (v.level === 'SYSTEM') === (v.subject_id === undefined), {
    path: ['subject_id'],
    message: 'subject_id is required for RESELLER/MERCHANT limits and forbidden for SYSTEM',
  });

export const limitQuerySchema = z.strictObject({
  level: limitLevelSchema,
  subject_id: idSchema('org').optional(),
});

export const effectiveLimitQuerySchema = z.strictObject({ merchant_id: idSchema('org') });

export const approvalTierSchema = z.strictObject({
  /** Inclusive upper bound in rupees; null = no upper bound (must be the last tier). */
  up_to: amountSchema.nullable(),
  approvals_required: z.number().int().min(0).max(3),
});

export const upsertApprovalPolicySchema = z
  .strictObject({
    level: limitLevelSchema,
    subject_id: idSchema('org').optional(),
    maker_checker_enabled: z.boolean(),
    tiers: z.array(approvalTierSchema).min(1).max(10),
    reason: z.string().trim().min(5).max(500),
  })
  .refine((v) => (v.level === 'SYSTEM') === (v.subject_id === undefined), {
    path: ['subject_id'],
    message: 'subject_id is required for RESELLER/MERCHANT policies and forbidden for SYSTEM',
  })
  .superRefine((v, ctx) => {
    v.tiers.forEach((t, i) => {
      const last = i === v.tiers.length - 1;
      if (last !== (t.up_to === null)) {
        ctx.addIssue({ code: 'custom', path: ['tiers', i, 'up_to'], message: 'Only the last tier must be open-ended' });
      }
      const prev = v.tiers[i - 1];
      if (prev?.up_to != null && t.up_to != null && t.up_to <= prev.up_to) {
        ctx.addIssue({ code: 'custom', path: ['tiers', i, 'up_to'], message: 'Tier bounds must increase' });
      }
    });
  });
