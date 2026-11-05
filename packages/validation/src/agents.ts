import { z } from 'zod';
import { passwordSchema } from './auth';
import { emailSchema, idSchema, mobileSchema } from './common';
import { BANK_ACCOUNT_RE, IFSC_RE, PINCODE_RE } from './india';
import { amountSchema } from './merchant';

/** Agents (customer service points), docs/AGENTS.md. Amounts are rupee strings ("1500.00") → paise. */

export const AGENT_PLAN_CODES = ['FREE', 'STARTER', 'BUSINESS'] as const;
export const AGENT_BILLING_PERIODS = ['MONTHLY', 'YEARLY'] as const;
export const AGENT_TXN_TYPES = ['MONEY_TRANSFER', 'CASH_WITHDRAWAL', 'CASH_DEPOSIT', 'BILL_PAYMENT', 'RECHARGE', 'OTHER'] as const;
export const AGENT_TXN_DIRECTIONS = ['IN', 'OUT'] as const;
export const AGENT_PAY_MODES = ['CASH', 'UPI', 'BANK', 'OTHER'] as const;
export const AGENT_TXN_STATUSES = ['SUCCESS', 'PENDING', 'FAILED', 'REFUNDED'] as const;
export const AGENT_ID_TYPES = ['AADHAAR', 'PAN', 'VOTER_ID', 'DRIVING_LICENCE', 'PASSPORT', 'OTHER'] as const;

/** Which way money moves at the counter for each type; OTHER needs an explicit direction. */
export const AGENT_TXN_DEFAULT_DIRECTION: Record<(typeof AGENT_TXN_TYPES)[number], 'IN' | 'OUT' | null> = {
  MONEY_TRANSFER: 'IN',
  CASH_WITHDRAWAL: 'OUT',
  CASH_DEPOSIT: 'IN',
  BILL_PAYMENT: 'IN',
  RECHARGE: 'IN',
  OTHER: null,
};

export const UPI_VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/;

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const positiveAmount = amountSchema.refine((v) => v >= 100n, 'Minimum amount is ₹1.00').refine((v) => v <= 100_000_000_00n, 'Maximum amount is ₹10,00,00,000');
const feeAmount = amountSchema.refine((v) => v >= 0n, 'Fee cannot be negative').refine((v) => v <= 1_000_000_00n, 'Fee is too large');

export const agentCustomerIdSchema = idSchema('acu');
export const agentBeneficiaryIdSchema = idSchema('abn');
export const agentTransactionIdSchema = idSchema('atx');
export const agentPlanOrderIdSchema = idSchema('apo');

// ---- Shop profile ---------------------------------------------------------------------------------

export const agentProfileUpdateSchema = z.strictObject({
  shop_name: text(120).min(2, 'Enter the shop name').optional(),
  owner_name: text(120).min(2, 'Enter the owner name').optional(),
  address_line: optText(255),
  city: optText(80),
  state: optText(80),
  pincode: z
    .string()
    .trim()
    .regex(PINCODE_RE, 'Enter a valid 6-digit PIN code')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  upi_vpa: z
    .string()
    .trim()
    .regex(UPI_VPA_RE, 'Enter a valid UPI id, e.g. shopname@okaxis')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  upi_payee_name: optText(100),
  receipt_footer: optText(200),
});

// ---- Customers & beneficiaries --------------------------------------------------------------------

export const agentCustomerSchema = z.strictObject({
  name: text(120).min(2, 'Enter the customer name'),
  mobile: mobileSchema,
  email: emailSchema.optional().nullable().or(z.literal('').transform(() => null)),
  address_line: optText(255),
  city: optText(80),
  pincode: z
    .string()
    .trim()
    .regex(PINCODE_RE, 'Enter a valid 6-digit PIN code')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  date_of_birth: z.iso.date('Enter a valid date').optional().nullable().or(z.literal('').transform(() => null)),
  id_type: z.enum(AGENT_ID_TYPES).optional().nullable(),
  id_number: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9 -]{4,20}$/, 'Enter a valid ID number')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  note: optText(255),
});

export const agentCustomerUpdateSchema = agentCustomerSchema.partial();

export const agentBeneficiarySchema = z
  .strictObject({
    name: text(120).min(2, 'Enter the beneficiary name'),
    bank_name: optText(120),
    account_number: z
      .string()
      .trim()
      .regex(BANK_ACCOUNT_RE, 'Account number is 9 to 18 digits')
      .optional()
      .nullable()
      .or(z.literal('').transform(() => null)),
    ifsc: z
      .string()
      .trim()
      .toUpperCase()
      .regex(IFSC_RE, 'Enter a valid IFSC, e.g. SBIN0001234')
      .optional()
      .nullable()
      .or(z.literal('').transform(() => null)),
    upi_id: z
      .string()
      .trim()
      .regex(UPI_VPA_RE, 'Enter a valid UPI id')
      .optional()
      .nullable()
      .or(z.literal('').transform(() => null)),
    relation: optText(40),
  })
  .superRefine((v, ctx) => {
    if (!v.account_number && !v.upi_id) ctx.addIssue({ code: 'custom', path: ['account_number'], message: 'Enter a bank account or a UPI id' });
    if (v.account_number && !v.ifsc) ctx.addIssue({ code: 'custom', path: ['ifsc'], message: 'IFSC is needed with an account number' });
  });

export const agentListQuerySchema = z.strictObject({
  search: z.string().trim().max(80).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ---- Transactions ---------------------------------------------------------------------------------

export const agentTransactionCreateSchema = z
  .strictObject({
    type: z.enum(AGENT_TXN_TYPES),
    /** Only for OTHER; every other type has a fixed direction. */
    direction: z.enum(AGENT_TXN_DIRECTIONS).optional(),
    mode: z.enum(AGENT_PAY_MODES).default('CASH'),
    status: z.enum(['SUCCESS', 'PENDING']).default('SUCCESS'),
    amount: positiveAmount,
    fee: feeAmount.default(0n),
    reference: optText(64),
    description: optText(255),
    customer_id: agentCustomerIdSchema.optional().nullable(),
    beneficiary_id: agentBeneficiaryIdSchema.optional().nullable(),
    /** Quick entry without a saved customer. */
    customer_name: optText(120),
    customer_mobile: mobileSchema.optional().nullable().or(z.literal('').transform(() => null)),
    /** When it really happened; default now. Up to 30 days back. */
    occurred_at: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'OTHER' && !v.direction) ctx.addIssue({ code: 'custom', path: ['direction'], message: 'Choose money in or money out' });
    if (v.type === 'MONEY_TRANSFER' && !v.customer_id) ctx.addIssue({ code: 'custom', path: ['customer_id'], message: 'Choose the sender' });
    if (v.type === 'MONEY_TRANSFER' && !v.beneficiary_id) ctx.addIssue({ code: 'custom', path: ['beneficiary_id'], message: 'Choose the beneficiary' });
    if (v.beneficiary_id && !v.customer_id) ctx.addIssue({ code: 'custom', path: ['customer_id'], message: 'A beneficiary needs its customer' });
  });

export const agentTransactionStatusSchema = z.strictObject({
  status: z.enum(AGENT_TXN_STATUSES),
  reference: optText(64),
  note: optText(255),
});

export const agentTransactionListQuerySchema = z.strictObject({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  type: z.enum(AGENT_TXN_TYPES).optional(),
  direction: z.enum(AGENT_TXN_DIRECTIONS).optional(),
  status: z.enum(AGENT_TXN_STATUSES).optional(),
  customer_id: agentCustomerIdSchema.optional(),
  search: z.string().trim().max(80).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const agentSendReceiptSchema = z.strictObject({
  channel: z.enum(['SMS', 'WHATSAPP']),
  /** Defaults to the customer's mobile on the transaction. */
  mobile: mobileSchema.optional(),
});

export const agentReportQuerySchema = z.strictObject({
  from: z.iso.date('Choose a start date'),
  to: z.iso.date('Choose an end date'),
});

// ---- Staff ----------------------------------------------------------------------------------------

export const agentStaffCreateSchema = z.strictObject({
  name: text(120).min(2, 'Enter the name'),
  email: emailSchema,
  mobile: mobileSchema,
  password: passwordSchema,
});

export const agentStaffStatusSchema = z.strictObject({ active: z.boolean() });

// ---- Billing --------------------------------------------------------------------------------------

export const agentCheckoutSchema = z.strictObject({
  plan_code: z.enum(['STARTER', 'BUSINESS']),
  period: z.enum(AGENT_BILLING_PERIODS),
});

// ---- Google Drive ---------------------------------------------------------------------------------

export const agentDriveSettingsSchema = z.strictObject({ auto_backup: z.boolean() });

// ---- Platform admin -------------------------------------------------------------------------------

export const agentPlanUpdateSchema = z.strictObject({
  name: text(40).min(2).optional(),
  description: text(255).optional(),
  price_monthly: amountSchema.refine((v) => v >= 0n, 'Price cannot be negative').optional(),
  price_yearly: amountSchema.refine((v) => v >= 0n, 'Price cannot be negative').optional(),
  /** null = unlimited. */
  monthly_txn_limit: z.number().int().min(1).max(10_000_000).nullable().optional(),
  staff_limit: z.number().int().min(1).max(500).optional(),
  drive_backup: z.boolean().optional(),
  branded_receipts: z.boolean().optional(),
  messaging: z.boolean().optional(),
  active: z.boolean().optional(),
});

export const agentGrantPlanSchema = z.strictObject({
  plan_code: z.enum(AGENT_PLAN_CODES),
  /** End of the granted period (ignored for FREE). */
  expires_at: z.iso.date().optional(),
  note: optText(255),
});

export const agentAdminStatusSchema = z.strictObject({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: optText(255) });

export const agentProgramSettingsSchema = z.strictObject({ billing_merchant_id: idSchema('org').nullable() });

export const agentAdminListQuerySchema = z.strictObject({
  search: z.string().trim().max(80).optional(),
  plan: z.enum(AGENT_PLAN_CODES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
