import { z } from 'zod';
import { idSchema } from './common';
import { amountSchema } from './merchant';

const rate = z.string().regex(/^\d{1,3}(\.\d{1,6})?$/, 'Percentage with up to 6 decimals, e.g. 0.18');

export const pricingRuleSchema = z
  .strictObject({
    service: z.enum(['PAYIN', 'PAYOUT']),
    method: z.string().regex(/^[A-Z_]{3,30}$/).nullable().default(null),
    provider_id: idSchema('prv').nullable().default(null),
    min_amount: amountSchema.nullable().default(null),
    max_amount: amountSchema.nullable().default(null),
    charge_type: z.enum(['FLAT', 'PERCENTAGE', 'PERCENTAGE_WITH_MIN_MAX']),
    /** Percent, e.g. "0.18" for 0.18 %. */
    rate: rate.nullable().default(null),
    flat_fee: amountSchema.nullable().default(null),
    min_fee: amountSchema.nullable().default(null),
    max_fee: amountSchema.nullable().default(null),
  })
  .refine((r) => (r.charge_type === 'FLAT' ? r.flat_fee !== null : r.rate !== null), { message: 'FLAT needs flat_fee; percentage types need rate', path: ['charge_type'] })
  .refine((r) => r.min_amount === null || r.max_amount === null || r.min_amount <= r.max_amount, { message: 'max_amount must be ≥ min_amount', path: ['max_amount'] });

export const createPricingPlanSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['PROVIDER_COST', 'WHOLESALE', 'MERCHANT']),
  is_default: z.boolean().default(false),
  tax_rate: rate.default('18'),
  refund_fee: z.boolean().default(false),
  effective_from: z.iso.datetime().optional(),
  effective_to: z.iso.datetime().nullable().optional(),
  rules: z.array(pricingRuleSchema).min(1).max(50),
});

export const assignPricingPlanSchema = z.strictObject({
  plan_id: idSchema('ppl'),
  subject_type: z.enum(['MERCHANT', 'RESELLER', 'PROVIDER']),
  subject_id: z.string().regex(/^(org|prv)_[0-9A-HJKMNP-TV-Z]{26}$/),
  effective_from: z.iso.datetime().optional(),
});

export const pricingQuoteSchema = z.strictObject({
  merchant_id: idSchema('org'),
  service: z.enum(['PAYIN', 'PAYOUT']),
  method: z.string().regex(/^[A-Z_]{3,30}$/),
  amount: amountSchema,
  provider_id: idSchema('prv').optional(),
});
