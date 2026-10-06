import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';
import { amountSchema } from './merchant';

export const ledgerBucketSchema = z.enum(['AVAILABLE', 'PENDING', 'UNSETTLED', 'SETTLED', 'RESERVED', 'LIEN', 'RECEIVABLE', 'COMMISSION_PAYABLE']);

export const listLedgerAccountsQuerySchema = paginationQuerySchema.extend({
  owner_type: z.enum(['PLATFORM', 'MERCHANT', 'RESELLER']).optional(),
  owner_id: idSchema('org').optional(),
  bucket: ledgerBucketSchema.optional(),
  search: z.string().trim().max(120).optional(),
});

export const statementQuerySchema = paginationQuerySchema.extend({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export const listJournalsQuerySchema = paginationQuerySchema.extend({
  type: z.string().regex(/^[A-Z_]{3,30}$/).optional(),
  source_type: z.string().regex(/^[A-Z_]{3,20}$/).optional(),
  source_id: z.string().trim().max(60).optional(),
  merchant_id: idSchema('org').optional(),
});

/** merchant_id may be omitted by merchant callers (dashboard or API key): their own balances. */
export const balancesQuerySchema = z.strictObject({ merchant_id: idSchema('org').optional() });

export const reverseJournalSchema = z.strictObject({ reason: z.string().trim().min(10, 'Explain the correction (at least 10 characters)').max(500) });

export const createAdjustmentSchema = z.strictObject({
  merchant_id: idSchema('org'),
  direction: z.enum(['CREDIT', 'DEBIT']),
  amount: amountSchema.refine((v) => v > 0n, 'Amount must be greater than zero'),
  reason: z.string().trim().min(10, 'Explain the adjustment (at least 10 characters)').max(500),
  reference: z.string().trim().min(3).max(120),
  supporting_note: z.string().trim().max(2000).optional(),
});

export const adjustmentDecisionSchema = z.strictObject({ comment: z.string().trim().max(500).optional() });
export const rejectAdjustmentSchema = z.strictObject({ reason: z.string().trim().min(5).max(500) });

export const listAdjustmentsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED']).optional(),
  merchant_id: idSchema('org').optional(),
});
