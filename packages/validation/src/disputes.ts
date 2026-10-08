import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';
import { amountSchema } from './merchant';

/** Disputes and chargebacks (docs/DISPUTES.md). */

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const openDisputeSchema = z.strictObject({
  payment_id: idSchema('pay'),
  /** Defaults to the whole disputable amount (captured minus refunded). */
  amount: amountSchema.refine((v) => v >= 100n, 'Minimum ₹1.00').optional(),
  reason_code: z.string().trim().regex(/^[A-Za-z0-9_.\-/]{1,40}$/, 'Reason code: up to 40 letters, digits, _ . - /'),
  reason: text(5, 500),
  respond_by_days: z.number().int().min(1).max(30).default(7),
  provider_case_id: z.string().trim().max(80).optional(),
});

export const submitDisputeSchema = z.strictObject({ note: text(10, 2000) });
export const acceptDisputeSchema = z.strictObject({ note: text(0, 2000).optional() });

export const resolveDisputeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('WON'), note: text(5, 500) }),
  z.strictObject({ outcome: z.literal('LOST'), note: text(5, 500), fee: amountSchema.refine((v) => v >= 0n, 'Fee can’t be negative').optional() }),
]);

export const listDisputesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['OPEN', 'UNDER_REVIEW', 'WON', 'LOST']).optional(),
  merchant_id: idSchema('org').optional(),
});

export const disputeIdSchema = idSchema('dsp');
export const disputeEvidenceIdSchema = idSchema('dev');
