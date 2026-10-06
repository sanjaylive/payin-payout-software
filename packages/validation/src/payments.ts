import { z } from 'zod';
import { emailSchema, idSchema, mobileSchema, paginationQuerySchema } from './common';
import { amountSchema } from './merchant';

const orderId = z.string().trim().regex(/^[A-Za-z0-9_\-/.:]{1,64}$/, 'Use 1–64 letters, digits or _ - / . :');

/** "UPI" is accepted as an alias for a QR collect (the customer can scan or use the intent). */
export const payinMethodInputSchema = z.enum(['UPI', 'UPI_QR', 'UPI_INTENT', 'PAYMENT_LINK']).transform((m) => (m === 'UPI' ? 'UPI_QR' : m));

export const createPaymentSchema = z.strictObject({
  merchant_order_id: orderId,
  /** Rupees as a string ("1000.00"); JSON numbers are rejected (no float ambiguity). */
  amount: amountSchema.refine((v) => v >= 100n, 'Minimum amount is ₹1.00'),
  currency: z.literal('INR').default('INR'),
  method: payinMethodInputSchema.default('UPI_QR'),
  customer: z
    .strictObject({
      name: z.string().trim().min(1).max(120).optional(),
      mobile: mobileSchema.optional(),
      email: emailSchema.optional(),
      vpa: z.string().trim().regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, 'Invalid UPI id').optional(),
    })
    .optional(),
  description: z.string().trim().max(200).optional(),
  expires_in_seconds: z.number().int().min(120).max(86_400).default(900),
  metadata: z
    .record(z.string().regex(/^[\w.-]{1,40}$/), z.string().max(256))
    .refine((m) => Object.keys(m).length <= 20, 'At most 20 metadata keys')
    .default({}),
});
export type CreatePaymentInput = z.input<typeof createPaymentSchema>;

const csvEnum = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(values)).max(values.length).optional());

export const listPaymentsQuerySchema = paginationQuerySchema.extend({
  status: csvEnum(['CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'SETTLEMENT_PENDING', 'SETTLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CHARGEBACK']),
  method: csvEnum(['UPI_QR', 'UPI_INTENT', 'PAYMENT_LINK']),
  payment_id: idSchema('pay').optional(),
  merchant_order_id: orderId.optional(),
  utr: z.string().trim().max(40).optional(),
  rrn: z.string().trim().max(40).optional(),
  merchant_id: idSchema('org').optional(),
  reseller_id: idSchema('org').optional(),
  provider_id: idSchema('prv').optional(),
  amount_min: amountSchema.optional(),
  amount_max: amountSchema.optional(),
  created_from: z.iso.datetime().optional(),
  created_to: z.iso.datetime().optional(),
  sort: z.enum(['created_desc', 'created_asc']).default('created_desc'),
});

export const createRefundSchema = z.strictObject({
  amount: amountSchema.refine((v) => v > 0n, 'Amount must be greater than zero'),
  reason: z.string().trim().max(300).optional(),
  merchant_refund_id: orderId.optional(),
});

export const listRefundsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW']).optional(),
  payment_id: idSchema('pay').optional(),
  merchant_id: idSchema('org').optional(),
});

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Idempotency-Key must be 1–64 characters [A-Za-z0-9_-]');

export const sandboxCompleteSchema = z.strictObject({ outcome: z.enum(['SUCCESS', 'FAILED']) });

export const paymentStatsQuerySchema = z.strictObject({
  merchant_id: idSchema('org').optional(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  bucket: z.enum(['hour', 'day']).default('day'),
});
