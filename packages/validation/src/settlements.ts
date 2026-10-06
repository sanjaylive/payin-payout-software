import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';
import { amountSchema } from './merchant';

export const settlementConfigSchema = z
  .strictObject({
    cycle: z.enum(['T0', 'T1', 'T2', 'CUSTOM']),
    custom_days: z.number().int().min(3).max(7).nullable().optional(),
    /** "HH:MM" IST. */
    cutoff_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour, IST)'),
    min_amount: amountSchema,
    destination: z.enum(['WALLET', 'BANK']),
    auto_settle: z.boolean(),
    reason: z.string().trim().min(5).max(300),
  })
  .refine((c) => c.cycle !== 'CUSTOM' || (c.custom_days !== null && c.custom_days !== undefined), { message: 'CUSTOM needs custom_days (3–7)', path: ['custom_days'] });

export const listSettlementsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['PROCESSING', 'PROCESSED', 'FAILED']).optional(),
  merchant_id: idSchema('org').optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const markSettlementPaidSchema = z.strictObject({
  utr: z.string().trim().regex(/^[A-Za-z0-9]{6,40}$/, 'Enter the bank UTR'),
  bank_reference: z.string().trim().max(80).optional(),
});
export const markSettlementFailedSchema = z.strictObject({ reason: z.string().trim().min(5).max(300) });

export const settlementHoldSchema = z.strictObject({ merchant_id: idSchema('org'), reason: z.string().trim().min(5).max(300) });
export const releaseHoldSchema = z.strictObject({ reason: z.string().trim().min(5).max(300) });

export const providerRemittanceSchema = z.strictObject({
  provider_id: idSchema('prv'),
  reference: z.string().trim().regex(/^[A-Za-z0-9_\-/.:]{3,80}$/),
  value_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: amountSchema.refine((v) => v > 0n, 'Amount must be positive'),
  cost: amountSchema,
  bank_ref: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/, 'Bank account ref like "nodal"').default('nodal'),
});

// ---- Reconciliation ---------------------------------------------------------------------------

export const reconUploadSchema = z.strictObject({
  provider_id: idSchema('prv'),
  kind: z.enum(['PAYIN', 'PAYOUT']),
});

export const listReconEntriesQuerySchema = paginationQuerySchema.extend({
  result: z.enum(['MATCHED', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'MISSING_INTERNAL', 'MISSING_PROVIDER', 'DUPLICATE']).optional(),
  resolution: z.enum(['NOT_REQUIRED', 'OPEN', 'RESOLVED']).optional(),
});

export const resolveReconEntrySchema = z.strictObject({
  action: z.enum(['NOTE', 'ACCEPT_PROVIDER_SUCCESS']),
  note: z.string().trim().min(10, 'Explain the resolution and the evidence').max(500),
});

/**
 * Provider statement CSV (generic format; adapters map their own reports onto it).
 * Required columns: reference, amount, status, date. Optional: provider_txn_id, utr, rrn.
 */
export const RECON_CSV_REQUIRED = ['reference', 'amount', 'status', 'date'] as const;
