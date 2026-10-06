import { MoneyError, parseMajorToMinor } from '@pay2all/ledger';
import { z } from 'zod';
import { emailSchema, idSchema, mobileSchema, paginationQuerySchema } from './common';
import {
  BANK_ACCOUNT_RE,
  CIN_RE,
  DIN_RE,
  ENTITY_TYPES,
  IFSC_RE,
  isValidGstin,
  LLPIN_RE,
  MCC_RE,
  PAN_RE,
  PINCODE_RE,
} from './india';

const upper = (re: RegExp, message: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(re, message));

export const panSchema = upper(PAN_RE, 'Enter a valid 10-character PAN');
export const gstinSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine(isValidGstin, 'Enter a valid GSTIN (format or check digit is wrong)');
export const cinSchema = upper(CIN_RE, 'Enter a valid 21-character CIN');
export const llpinSchema = upper(LLPIN_RE, 'Enter a valid LLPIN (e.g. AAA-1234)');
export const ifscSchema = upper(IFSC_RE, 'Enter a valid 11-character IFSC');
export const bankAccountNumberSchema = z.string().trim().regex(BANK_ACCOUNT_RE, 'Account number must be 9–18 digits');

/** Rupee amount as a string in major units ("150000.00"), parsed exactly into paise (bigint). */
export const amountSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    try {
      return parseMajorToMinor(v, 'INR');
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: err instanceof MoneyError ? err.message : 'Invalid amount' });
      return z.NEVER;
    }
  });

export const addressSchema = z.strictObject({
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z.string().trim().regex(PINCODE_RE, 'Enter a valid 6-digit PIN code'),
  country: z.literal('IN').default('IN'),
});
export type Address = z.output<typeof addressSchema>;

export const entityTypeSchema = z.enum(ENTITY_TYPES);
export const settlementCycleSchema = z.enum(['T0', 'T1', 'T2', 'CUSTOM']);
export const riskCategorySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const merchantStatusSchema = z.enum([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'MORE_INFORMATION_REQUIRED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
]);

const urlSchema = z.url({ protocol: /^https?$/ }).max(300);

/**
 * Business profile. Every field is optional so drafts can be saved section by section; completeness
 * is enforced server-side at submission (docs/ROADMAP.md Phase 2).
 */
export const merchantProfileSchema = z.strictObject({
  legal_name: z.string().trim().min(2).max(200).optional(),
  display_name: z.string().trim().min(2).max(120).optional(),
  entity_type: entityTypeSchema.optional(),
  pan: panSchema.optional(),
  gstin: gstinSchema.nullable().optional(),
  cin: cinSchema.nullable().optional(),
  llpin: llpinSchema.nullable().optional(),
  registered_address: addressSchema.optional(),
  operational_address: addressSchema.nullable().optional(),
  website: urlSchema.nullable().optional(),
  app_url: urlSchema.nullable().optional(),
  business_category: z.string().trim().min(2).max(100).optional(),
  mcc: z.string().trim().regex(MCC_RE, 'MCC must be 4 digits').optional(),
  business_description: z.string().trim().min(20, 'Describe the business in at least 20 characters').max(2000).optional(),
  expected_monthly_volume: amountSchema.optional(),
  average_ticket_size: amountSchema.optional(),
  maximum_ticket_size: amountSchema.optional(),
  payin_required: z.boolean().optional(),
  payout_required: z.boolean().optional(),
  settlement_preference: settlementCycleSchema.optional(),
  contact_name: z.string().trim().min(2).max(120).optional(),
  contact_email: emailSchema.optional(),
  contact_mobile: mobileSchema.optional(),
});
export type MerchantProfileInput = z.input<typeof merchantProfileSchema>;

export const merchantPersonSchema = z
  .strictObject({
    full_name: z.string().trim().min(2).max(120),
    designation: z.string().trim().max(80).optional(),
    pan: panSchema,
    din: z.string().trim().regex(DIN_RE, 'DIN must be 8 digits').nullable().optional(),
    email: emailSchema.nullable().optional(),
    mobile: mobileSchema.nullable().optional(),
    is_director: z.boolean().default(false),
    is_ubo: z.boolean().default(false),
    is_authorized_signatory: z.boolean().default(false),
    /** Percentage with up to 2 decimals, e.g. "51.00". */
    ownership_percent: z
      .string()
      .trim()
      .regex(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/, 'Ownership must be 0–100 with up to 2 decimals')
      .nullable()
      .optional(),
  })
  .refine((p) => p.is_director || p.is_ubo || p.is_authorized_signatory, {
    message: 'Select at least one role',
    path: ['is_director'],
  });
export type MerchantPersonInput = z.input<typeof merchantPersonSchema>;

export const merchantBankAccountSchema = z.strictObject({
  account_holder_name: z.string().trim().min(2).max(120),
  account_number: bankAccountNumberSchema,
  ifsc: ifscSchema,
  account_type: z.enum(['CURRENT', 'SAVINGS']).default('CURRENT'),
  bank_name: z.string().trim().max(120).optional(),
});
export type MerchantBankAccountInput = z.input<typeof merchantBankAccountSchema>;

export const DOCUMENT_TYPES = [
  'PAN',
  'GST_CERTIFICATE',
  'CIN_CERTIFICATE',
  'ADDRESS_PROOF',
  'BANK_PROOF',
  'CANCELLED_CHEQUE',
  'DIRECTOR_KYC',
  'AGREEMENT',
  'OTHER',
] as const;
export const documentTypeSchema = z.enum(DOCUMENT_TYPES);

/** Multipart form fields accompanying a document upload. */
export const documentUploadSchema = z.strictObject({
  type: documentTypeSchema,
  person_id: idSchema('mpr').optional(),
  description: z.string().trim().max(200).optional(),
});

export const documentReviewSchema = z
  .strictObject({
    status: z.enum(['VERIFIED', 'REJECTED']),
    reason: z.string().trim().max(500).optional(),
    expires_at: z.iso.date().optional(),
  })
  .refine((v) => v.status !== 'REJECTED' || (v.reason?.length ?? 0) >= 5, {
    path: ['reason'],
    message: 'Give a reason (at least 5 characters) when rejecting',
  });

export const bankAccountVerificationSchema = z.strictObject({
  status: z.enum(['VERIFIED', 'FAILED']),
  reference: z.string().trim().min(3).max(100),
  notes: z.string().trim().max(500).optional(),
});

export const screeningStatusSchema = z.enum(['NOT_STARTED', 'PENDING', 'CLEAR', 'MATCH_FOUND', 'FALSE_POSITIVE']);
export const screeningUpdateSchema = z.strictObject({
  sanctions_status: screeningStatusSchema.optional(),
  pep_status: screeningStatusSchema.optional(),
  adverse_media_status: screeningStatusSchema.optional(),
  risk_category: riskCategorySchema.optional(),
  notes: z.string().trim().max(2000).optional(),
});

/** Reviewer decision on a merchant application. Reason and notes are always recorded. */
export const complianceDecisionSchema = z.strictObject({
  reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500),
  notes: z.string().trim().max(4000).optional(),
});

export const approveMerchantSchema = complianceDecisionSchema.extend({
  risk_category: riskCategorySchema,
  payin_enabled: z.boolean(),
  payout_enabled: z.boolean(),
});

export const merchantSettingsSchema = z.strictObject({
  payin_enabled: z.boolean().optional(),
  payout_enabled: z.boolean().optional(),
  risk_category: riskCategorySchema.optional(),
  reason: z.string().trim().min(5).max(500),
});

export const createMerchantSchema = z.strictObject({
  display_name: z.string().trim().min(2).max(120),
  /** Platform staff may place a merchant under a reseller. Resellers always create under themselves. */
  reseller_id: idSchema('org').optional(),
  /** Platform staff may place a merchant under an API partner (mutually exclusive with reseller_id). */
  partner_id: idSchema('org').optional(),
  source: z.string().trim().max(80).optional(),
}).refine((b) => !(b.reseller_id && b.partner_id), { message: 'Choose a reseller or an API partner, not both', path: ['partner_id'] });

export const listMerchantsQuerySchema = paginationQuerySchema.extend({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(merchantStatusSchema).max(7).optional()),
  reseller_id: idSchema('org').optional(),
  search: z.string().trim().max(100).optional(),
});
