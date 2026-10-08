import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';
import { amountSchema } from './merchant';

/** Wallet fund requests and the collection accounts merchants pay into (docs/FUND_REQUESTS.md). */

export const FUND_MODES = ['UPI', 'IMPS', 'NEFT', 'RTGS', 'CASH_DEPOSIT', 'OTHER'] as const;

const reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300);
const plain = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[<>]/.test(v), 'Plain text only');
const positive = amountSchema.refine((v) => v > 0n, 'Must be more than zero');

const common = {
  label: plain(2, 80),
  min_amount: positive.nullable().default(null),
  max_amount: positive.nullable().default(null),
  instructions: plain(0, 300).transform((v) => v || null).nullable().default(null),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(1000).default(100),
  reason,
};

export const collectionAccountSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('BANK'),
      account_holder: plain(2, 120),
      /** Omit on edit to keep the stored number. */
      account_number: z.string().trim().regex(/^\d{9,18}$/, 'Account numbers have 9–18 digits').optional(),
      ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC, e.g. HDFC0001234'),
      bank_name: plain(2, 80),
      branch: plain(0, 120).transform((v) => v || null).nullable().default(null),
      account_type: z.enum(['CURRENT', 'SAVINGS']).default('CURRENT'),
      ...common,
    }),
    z.strictObject({
      kind: z.literal('UPI'),
      upi_id: z.string().trim().regex(/^[a-zA-Z0-9._-]{2,255}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/, 'Enter a valid UPI ID, e.g. pay2all@hdfcbank'),
      payee_name: plain(2, 100),
      ...common,
    }),
  ])
  .refine((a) => a.min_amount === null || a.max_amount === null || a.min_amount <= a.max_amount, { path: ['max_amount'], message: 'Maximum must be at least the minimum' });

export const createFundRequestSchema = z.strictObject({
  collection_account_id: idSchema('cac'),
  amount: positive,
  mode: z.enum(FUND_MODES),
  /** UTR / RRN / reference as shown by the bank or UPI app. */
  utr: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^[A-Z0-9]{6,30}$/, 'Enter the UTR / reference number (6–30 letters or digits)')),
  paid_at: z.iso.datetime({ offset: true }),
  remarks: plain(0, 300).transform((v) => v || null).nullable().default(null),
});

export const decideFundRequestSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('APPROVE'), credited_amount: positive.optional(), note: plain(0, 300).optional() }),
  z.strictObject({ decision: z.literal('REJECT'), note: plain(5, 300) }),
]);

export const listFundRequestsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  merchant_id: idSchema('org').optional(),
  q: z.string().trim().max(60).optional(),
});
