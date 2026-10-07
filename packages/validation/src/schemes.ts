import { z } from 'zod';
import { idSchema } from './common';
import { amountSchema } from './merchant';

/**
 * Pricing schemes (docs/PRICING_SCHEMES.md). Values are signed decimal strings — JSON numbers are
 * rejected like every other amount: "-5" = ₹5 / 5 % charge, "2.5" = ₹2.50 / 2.5 % commission.
 */

export const PRICING_METHODS = {
  PAYIN: ['UPI_QR', 'UPI_INTENT', 'UPI_STATIC_QR', 'PAYMENT_LINK', 'VIRTUAL_ACCOUNT', 'CARD', 'NETBANKING'],
  PAYOUT: ['IMPS', 'NEFT', 'RTGS', 'UPI'],
} as const;

const reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300);
const description = z.string().trim().max(300).nullable().default(null);

export const pricingProviderSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(80),
    service: z.enum(['PAYIN', 'PAYOUT']),
    methods: z.array(z.string()).min(1, 'Choose at least one method').max(12),
    description,
    is_active: z.boolean().default(true),
    reason,
  })
  .superRefine((p, ctx) => {
    const allowed: readonly string[] = PRICING_METHODS[p.service];
    p.methods.forEach((m, i) => {
      if (!allowed.includes(m)) ctx.addIssue({ code: 'custom', path: ['methods', i], message: `${m} is not a ${p.service === 'PAYIN' ? 'payin method' : 'payout mode'}` });
    });
    if (new Set(p.methods).size !== p.methods.length) ctx.addIssue({ code: 'custom', path: ['methods'], message: 'Methods must be unique' });
  });

export const pricingProviderIdSchema = z.coerce.number().int().min(1).max(1_000_000);

/** Signed percent (up to 4 decimals, |v| ≤ 100) or rupees (2 decimals, |v| ≤ 1,00,000). */
const signedValue = z.string().trim().regex(/^-?\d{1,6}(\.\d{1,6})?$/, 'Enter a number like -5, 0.25 or -1.5');

export const schemeRateSchema = z
  .strictObject({
    provider_id: z.number().int().min(1),
    min_amount: amountSchema,
    max_amount: amountSchema.nullable().default(null),
    type: z.enum(['PERCENT', 'FLAT']),
    value: signedValue,
  })
  .superRefine((r, ctx) => {
    if (r.max_amount !== null && r.max_amount < r.min_amount) ctx.addIssue({ code: 'custom', path: ['max_amount'], message: 'To must be ≥ From' });
    const [whole = '', frac = ''] = r.value.replace('-', '').split('.');
    if (r.type === 'FLAT' && (frac.length > 2 || Number(whole) > 100_000)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Flat values are rupees: up to ₹1,00,000 with 2 decimals' });
    if (r.type === 'PERCENT' && (frac.length > 4 || Number(whole) > 100 || (Number(whole) === 100 && /[1-9]/.test(frac)))) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Percent values are up to 100 with 4 decimals' });
  });

export const saveSchemeSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  description,
  /** GST on charges, percent. */
  tax_rate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Percentage, e.g. 18').default('18'),
  rates: z.array(schemeRateSchema).max(200),
  /** Optimistic concurrency on edit. */
  version: z.number().int().min(1).optional(),
  reason,
});

export const setDefaultSchemeSchema = z.strictObject({ scheme_id: idSchema('sch').nullable(), reason });
export const removePricingProviderSchema = z.strictObject({ reason });
export const archiveSchemeSchema = z.strictObject({ reason });

export const assignSchemeSchema = z
  .strictObject({
    /** null = back to the default scheme. */
    scheme_id: idSchema('sch').nullable(),
    target: z.enum(['MERCHANTS', 'ALL']),
    merchant_ids: z.array(idSchema('org')).max(500).default([]),
    /** ALL only: also move resellers' merchants off their reseller's rate card. */
    include_reseller_merchants: z.boolean().default(false),
    reason,
  })
  .refine((a) => a.target === 'ALL' || a.merchant_ids.length > 0, { path: ['merchant_ids'], message: 'Choose at least one merchant' });

export const schemeMerchantsQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  scheme: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(60).optional(),
});

export const schemePreviewSchema = z.strictObject({
  merchant_id: idSchema('org').optional(),
  scheme_id: idSchema('sch').optional(),
  method: z.string().regex(/^[A-Z_]{3,30}$/),
  amount: amountSchema,
});
