import { z } from 'zod';
import { emailSchema, idSchema, mobileSchema, paginationQuerySchema } from './common';
import { IFSC_RE } from './india';
import { amountSchema, bankAccountNumberSchema, ifscSchema } from './merchant';

export const PAYOUT_MODES = ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const;
export type PayoutModeValue = (typeof PAYOUT_MODES)[number];
export const PAYOUT_PURPOSES = ['CUSTOMER_PAYOUT', 'VENDOR_PAYMENT', 'REFUND_PAYOUT', 'SALARY', 'API_PAYOUT'] as const;

const orderId = z.string().trim().regex(/^[A-Za-z0-9_\-/.:]{1,64}$/, 'Use 1–64 letters, digits or _ - / . :');
export const upiIdSchema = z.string().trim().toLowerCase().regex(/^[\w.-]{2,256}@[a-z][a-z0-9]{1,63}$/, 'Enter a valid UPI ID like name@bank');
const beneficiaryName = z.string().trim().min(2, 'Enter the beneficiary name').max(120);
const narration = z.string().trim().regex(/^[A-Za-z0-9 .,/\-_]{0,100}$/, 'Narration may contain letters, digits and . , / - _ (max 100)');

/** Mode rules (PAYOUT_FLOW.md §1). Amounts in paise. */
export const MODE_RULES: Record<PayoutModeValue, { minMinor?: bigint; maxMinor?: bigint; needs: 'ACCOUNT' | 'UPI' }> = {
  IMPS: { maxMinor: 50_000_000n, needs: 'ACCOUNT' },
  NEFT: { needs: 'ACCOUNT' },
  RTGS: { minMinor: 20_000_000n, needs: 'ACCOUNT' },
  UPI: { maxMinor: 10_000_000n, needs: 'UPI' },
};

export function modeViolation(mode: PayoutModeValue, amountMinor: bigint): string | null {
  const r = MODE_RULES[mode];
  if (r.minMinor !== undefined && amountMinor < r.minMinor) return `${mode} requires at least ₹${(r.minMinor / 100n).toLocaleString('en-IN')}`;
  if (r.maxMinor !== undefined && amountMinor > r.maxMinor) return `${mode} allows at most ₹${(r.maxMinor / 100n).toLocaleString('en-IN')} per payout`;
  return null;
}

export const beneficiaryInputSchema = z
  .strictObject({
    name: beneficiaryName,
    type: z.enum(['INDIVIDUAL', 'BUSINESS']).default('INDIVIDUAL'),
    account_number: bankAccountNumberSchema.optional(),
    ifsc: ifscSchema.optional(),
    upi_id: upiIdSchema.optional(),
    mobile: mobileSchema.optional(),
    email: emailSchema.optional(),
  })
  .refine((b) => (b.account_number ? Boolean(b.ifsc) : true), { message: 'IFSC is required with an account number', path: ['ifsc'] })
  .refine((b) => Boolean(b.account_number) !== Boolean(b.upi_id), { message: 'Provide either a bank account (account_number + ifsc) or a upi_id', path: ['account_number'] });

export const createBeneficiarySchema = beneficiaryInputSchema;

export const createPayoutSchema = z
  .strictObject({
    merchant_order_id: orderId,
    amount: amountSchema.refine((v) => v >= 100n, 'Minimum payout is ₹1.00'),
    currency: z.literal('INR').default('INR'),
    mode: z.enum(PAYOUT_MODES),
    purpose: z.enum(PAYOUT_PURPOSES).default('VENDOR_PAYMENT'),
    beneficiary: z.union([z.strictObject({ beneficiary_id: idSchema('ben') }), beneficiaryInputSchema]),
    narration: narration.optional(),
    metadata: z
      .record(z.string().regex(/^[\w.-]{1,40}$/), z.string().max(256))
      .refine((m) => Object.keys(m).length <= 20, 'At most 20 metadata keys')
      .default({}),
  })
  .superRefine((p, ctx) => {
    const v = modeViolation(p.mode, p.amount);
    if (v) ctx.addIssue({ code: 'custom', path: ['amount'], message: v });
    if ('name' in p.beneficiary) {
      const needs = MODE_RULES[p.mode].needs;
      if (needs === 'UPI' && !p.beneficiary.upi_id) ctx.addIssue({ code: 'custom', path: ['beneficiary', 'upi_id'], message: 'UPI payouts need a upi_id' });
      if (needs === 'ACCOUNT' && !p.beneficiary.account_number) ctx.addIssue({ code: 'custom', path: ['beneficiary', 'account_number'], message: `${p.mode} payouts need a bank account` });
    }
  });
export type CreatePayoutInput = z.input<typeof createPayoutSchema>;

const csvEnum = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(values)).max(values.length).optional());

export const listPayoutsQuerySchema = paginationQuerySchema.extend({
  status: csvEnum(['CREATED', 'VALIDATING', 'APPROVAL_PENDING', 'MANUAL_REVIEW', 'QUEUED', 'PROCESSING', 'PENDING', 'SUCCESS', 'FAILED', 'REJECTED', 'REVERSED']),
  mode: csvEnum(PAYOUT_MODES),
  purpose: z.enum(PAYOUT_PURPOSES).optional(),
  payout_id: idSchema('pout').optional(),
  merchant_order_id: orderId.optional(),
  utr: z.string().trim().max(40).optional(),
  beneficiary_id: idSchema('ben').optional(),
  merchant_id: idSchema('org').optional(),
  bulk_batch_id: idSchema('bpb').optional(),
  awaiting_my_approval: z.enum(['true', 'false']).optional(),
  amount_min: amountSchema.optional(),
  amount_max: amountSchema.optional(),
  created_from: z.iso.datetime().optional(),
  created_to: z.iso.datetime().optional(),
});

export const listBeneficiariesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['PENDING', 'VERIFIED', 'FAILED', 'BLOCKED']).optional(),
  search: z.string().trim().max(120).optional(),
  merchant_id: idSchema('org').optional(),
});

export const payoutDecisionSchema = z.strictObject({ reason: z.string().trim().min(3).max(300).optional() });
export const payoutRejectSchema = z.strictObject({ reason: z.string().trim().min(3, 'Give a reason').max(300) });
export const blockBeneficiarySchema = z.strictObject({ reason: z.string().trim().min(5).max(300) });

/** Platform resolution of a payout stuck in MANUAL_REVIEW — evidence required. */
export const resolvePayoutReviewSchema = z
  .strictObject({
    outcome: z.enum(['SUCCESS', 'FAILED']),
    utr: z.string().trim().regex(/^[A-Za-z0-9]{6,40}$/).optional(),
    reason: z.string().trim().min(10, 'Describe the bank/provider evidence').max(300),
  })
  .refine((r) => r.outcome !== 'SUCCESS' || Boolean(r.utr), { message: 'A UTR from the bank is required to mark a payout successful', path: ['utr'] });

export const sandboxPayoutSchema = z.strictObject({ outcome: z.enum(['SUCCESS', 'FAILED', 'REVERSED']) });

// ---- Bulk CSV --------------------------------------------------------------------------------------

export const BULK_CSV_COLUMNS = ['merchant_order_id', 'amount', 'mode', 'beneficiary_name', 'account_number', 'ifsc', 'upi_id', 'purpose', 'narration'] as const;
export const BULK_MAX_ROWS = 1000;

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF). Returns rows of raw strings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export const bulkRowSchema = z
  .object({
    merchant_order_id: orderId,
    amount: amountSchema.refine((v) => v >= 100n, 'Minimum payout is ₹1.00'),
    mode: z.string().trim().toUpperCase().pipe(z.enum(PAYOUT_MODES)),
    beneficiary_name: beneficiaryName,
    account_number: z.union([z.literal(''), bankAccountNumberSchema]),
    ifsc: z.union([z.literal(''), z.string().trim().toUpperCase().regex(IFSC_RE, 'Invalid IFSC')]),
    upi_id: z.union([z.literal(''), upiIdSchema]),
    purpose: z.union([z.literal(''), z.string().trim().toUpperCase().pipe(z.enum(PAYOUT_PURPOSES))]),
    narration: z.union([z.literal(''), narration]),
  })
  .superRefine((r, ctx) => {
    const v = modeViolation(r.mode, r.amount);
    if (v) ctx.addIssue({ code: 'custom', path: ['amount'], message: v });
    if (MODE_RULES[r.mode].needs === 'UPI' && !r.upi_id) ctx.addIssue({ code: 'custom', path: ['upi_id'], message: 'UPI payouts need upi_id' });
    if (MODE_RULES[r.mode].needs === 'ACCOUNT' && (!r.account_number || !r.ifsc)) ctx.addIssue({ code: 'custom', path: ['account_number'], message: `${r.mode} payouts need account_number and ifsc` });
  });

// ---- Beneficiary name match ------------------------------------------------------------------------

const HONORIFICS = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'SHRI', 'SMT', 'KUMARI', 'M/S', 'MESSRS']);
const EXPAND: Record<string, string> = { PVT: 'PRIVATE', LTD: 'LIMITED', CO: 'COMPANY', CORP: 'CORPORATION', INTL: 'INTERNATIONAL' };

function nameTokens(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/M\/S/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !HONORIFICS.has(t))
    .map((t) => EXPAND[t] ?? t);
}

/**
 * 0–100 similarity between the declared and the bank-registered name. Token based, order
 * insensitive, tolerant of initials ("R SHARMA" ~ "ROHIT SHARMA") and honorifics.
 */
export function nameMatchScore(declared: string, registered: string): number {
  const a = nameTokens(declared);
  const b = nameTokens(registered);
  if (!a.length || !b.length) return 0;
  const used = new Set<number>();
  let matched = 0;
  for (const t of a) {
    let idx = b.findIndex((u, i) => !used.has(i) && u === t);
    let weight = 1;
    if (idx < 0) {
      idx = b.findIndex((u, i) => !used.has(i) && (t.length === 1 ? u.startsWith(t) : u.length === 1 && t.startsWith(u)));
      weight = 0.75;
    }
    if (idx >= 0) {
      used.add(idx);
      matched += weight;
    }
  }
  return Math.round((matched / Math.max(a.length, b.length)) * 100);
}

export const NAME_MATCH_THRESHOLD = 70;

// ---- Dashboard forms (plain strings, mapped on submit) ---------------------------------------------

export const payoutFormSchema = z.object({
  merchant_order_id: orderId,
  amount: z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Enter an amount like 15000 or 15000.50').refine((v) => !/^0+(\.\d*)?$/.test(v), 'Minimum payout is ₹1.00'),
  mode: z.enum(PAYOUT_MODES),
  purpose: z.enum(PAYOUT_PURPOSES),
  beneficiary_id: z.string().regex(/^ben_[0-9A-HJKMNP-TV-Z]{26}$/, 'Choose a beneficiary'),
  narration,
});

export const beneficiaryFormSchema = z
  .object({
    name: beneficiaryName,
    type: z.enum(['INDIVIDUAL', 'BUSINESS']),
    destination: z.enum(['ACCOUNT', 'UPI']),
    account_number: z.string().trim(),
    confirm_account_number: z.string().trim(),
    ifsc: z.string().trim(),
    upi_id: z.string().trim(),
  })
  .superRefine((b, ctx) => {
    if (b.destination === 'ACCOUNT') {
      if (!/^[0-9]{9,18}$/.test(b.account_number)) ctx.addIssue({ code: 'custom', path: ['account_number'], message: 'Account number must be 9–18 digits' });
      if (b.account_number !== b.confirm_account_number) ctx.addIssue({ code: 'custom', path: ['confirm_account_number'], message: 'Account numbers do not match' });
      if (!IFSC_RE.test(b.ifsc.toUpperCase())) ctx.addIssue({ code: 'custom', path: ['ifsc'], message: 'Enter a valid 11-character IFSC' });
    } else if (!/^[\w.-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(b.upi_id)) ctx.addIssue({ code: 'custom', path: ['upi_id'], message: 'Enter a valid UPI ID like name@bank' });
  });
