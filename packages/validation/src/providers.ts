import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';
import { amountSchema, riskCategorySchema } from './merchant';

export const providerKindSchema = z.enum(['PAYIN', 'PAYOUT', 'BOTH']);
export const providerEnvironmentSchema = z.enum(['TEST', 'LIVE']);

const capabilities = z.strictObject({
  payin_methods: z.array(z.enum(['UPI_QR', 'UPI_INTENT', 'PAYMENT_LINK', 'VIRTUAL_ACCOUNT', 'IMPS', 'NEFT', 'RTGS', 'CARD', 'NETBANKING'])).max(10).optional(),
  payout_modes: z.array(z.enum(['IMPS', 'NEFT', 'RTGS', 'UPI'])).max(4).optional(),
  min_amount_minor: z.string().regex(/^\d{1,17}$/).optional(),
  max_amount_minor: z.string().regex(/^\d{1,17}$/).optional(),
});
const costs = z.strictObject({
  payin_rate_micros: z.string().regex(/^\d{1,9}$/).optional(),
  payout_flat_minor: z.string().regex(/^\d{1,12}$/).optional(),
});
/** Non-secret adapter configuration. Secrets belong in credentials, never here. */
const config = z
  .record(z.string().regex(/^[a-z_]{2,40}$/), z.union([z.string().max(500), z.number(), z.boolean()]))
  .refine((c) => Object.keys(c).length <= 20, 'Too many config keys')
  .refine((c) => !Object.keys(c).some((k) => /secret|password|token|api_key/.test(k)), 'Put secrets in credentials, not config');

export const createProviderSchema = z.strictObject({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'Lowercase letters, digits and dashes'),
  name: z.string().trim().min(2).max(120),
  kind: providerKindSchema,
  adapter: z.string().regex(/^[a-z0-9-]{2,40}$/),
  environment: providerEnvironmentSchema.default('TEST'),
  capabilities: capabilities.default({}),
  config: config.default({}),
  costs: costs.default({}),
  /** API vendor (company) this payment service belongs to (docs/VENDORS.md). */
  vendor_id: idSchema('avd').optional(),
});

export const updateProviderSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  environment: providerEnvironmentSchema.optional(),
  capabilities: capabilities.optional(),
  config: config.optional(),
  costs: costs.optional(),
  reason: z.string().trim().min(5).max(500),
});

export const providerStatusSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'DISABLED']),
  reason: z.string().trim().min(5).max(300),
});

export const providerCredentialsSchema = z.strictObject({
  environment: providerEnvironmentSchema,
  values: z.record(z.string().regex(/^[a-z_]{2,40}$/), z.string().min(1).max(4096)).refine((v) => Object.keys(v).length > 0, 'Provide at least one credential'),
});

const timeWindow = z.strictObject({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
});

export const routeSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(120),
    service: z.enum(['PAYIN', 'PAYOUT']),
    tier: z.enum(['PRIMARY', 'SECONDARY', 'FALLBACK']).default('PRIMARY'),
    priority: z.number().int().min(0).max(10_000).default(100),
    provider_id: idSchema('prv'),
    merchant_id: idSchema('org').nullable().optional(),
    reseller_id: idSchema('org').nullable().optional(),
    method: z.string().regex(/^[A-Z_]{3,30}$/).nullable().optional(),
    min_amount: amountSchema.nullable().optional(),
    max_amount: amountSchema.nullable().optional(),
    risk_categories: z.array(riskCategorySchema).max(3).default([]),
    time_window: timeWindow.nullable().optional(),
    is_active: z.boolean().default(true),
  })
  .refine((r) => r.min_amount == null || r.max_amount == null || r.min_amount <= r.max_amount, { path: ['max_amount'], message: 'Maximum must be ≥ minimum' });

export const listRoutesQuerySchema = paginationQuerySchema.extend({
  service: z.enum(['PAYIN', 'PAYOUT']).optional(),
  provider_id: idSchema('prv').optional(),
});

export const simulateRouteSchema = z.strictObject({
  service: z.enum(['PAYIN', 'PAYOUT']),
  merchant_id: idSchema('org'),
  amount: amountSchema,
  method: z.string().regex(/^[A-Z_]{3,30}$/),
  at: z.iso.datetime().optional(),
});
