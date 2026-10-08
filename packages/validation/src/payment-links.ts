import { z } from 'zod';
import { emailSchema, idSchema, mobileSchema, paginationQuerySchema } from './common';
import { amountSchema } from './merchant';

/** Payment links, payment pages and static QR (docs/PAYMENT_LINKS.md, docs/STATIC_QR.md). */

const minAmount = amountSchema.refine((v) => v >= 100n, 'Minimum amount is ₹1.00');
const reference = z.string().trim().regex(/^[A-Za-z0-9_\-/.:]{1,60}$/, 'Use 1–60 letters, digits or _ - / . :');

// ---- Payment links ------------------------------------------------------------------------------

export const createPaymentLinkSchema = z.strictObject({
  amount: minAmount,
  currency: z.literal('INR').default('INR'),
  /** What the customer is paying for — shown on the payment page and in messages. */
  description: z.string().trim().min(2, 'Say what this payment is for').max(200),
  /** Your reference (invoice number…); one link per reference. Generated when omitted. */
  reference: reference.optional(),
  customer: z
    .strictObject({ name: z.string().trim().min(1).max(120).optional(), email: emailSchema.optional(), mobile: mobileSchema.optional() })
    .optional(),
  expires_in_days: z.number().int().min(1).max(90).default(7),
  /** Send the link to the customer right away. */
  notify: z.strictObject({ email: z.boolean().default(false), sms: z.boolean().default(false) }).default({ email: false, sms: false }),
  metadata: z
    .record(z.string().regex(/^[\w.-]{1,40}$/), z.string().max(256))
    .refine((m) => Object.keys(m).length <= 20, 'At most 20 metadata keys')
    .default({}),
});

export const listPaymentLinksQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['OPEN', 'PAID', 'EXPIRED', 'CANCELLED']).optional(),
  reference: z.string().max(60).optional(),
});

export const notifyPaymentLinkSchema = z
  .strictObject({ email: z.boolean().default(false), sms: z.boolean().default(false) })
  .refine((v) => v.email || v.sms, 'Choose email, SMS or both');

export const paymentLinkIdSchema = idSchema('cs');

// ---- Payment pages ------------------------------------------------------------------------------

const RESERVED_SLUGS = new Set(['admin', 'api', 'app', 'login', 'pay', 'checkout', 'docs', 'help', 'support', 'settings', 'static', 'www']);

export const pageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/, 'Use 3–60 lowercase letters, digits and hyphens')
  .refine((s) => !RESERVED_SLUGS.has(s), 'This address is reserved');

export const PAGE_FIELD_TYPES = ['text', 'number', 'email', 'phone'] as const;

export const pageFieldSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, 'Field keys: lowercase letters, digits, underscore'),
  label: z.string().trim().min(1).max(60),
  type: z.enum(PAGE_FIELD_TYPES).default('text'),
  required: z.boolean().default(false),
});

const pageBase = {
  title: z.string().trim().min(3, 'Give the page a title').max(120),
  description: z.string().trim().max(1000).optional(),
  success_message: z.string().trim().max(300).optional(),
  fields: z
    .array(pageFieldSchema)
    .max(5, 'At most 5 extra fields')
    .refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'Field keys must be unique')
    .default([]),
};

const pageAmount = z.discriminatedUnion('amount_type', [
  z.strictObject({ amount_type: z.literal('FIXED'), amount: minAmount }),
  z.strictObject({ amount_type: z.literal('CUSTOMER'), min_amount: minAmount, max_amount: minAmount }),
]);

export const savePaymentPageSchema = z
  .strictObject({ slug: pageSlugSchema, ...pageBase, amount: pageAmount })
  .superRefine((v, ctx) => {
    if (v.amount.amount_type === 'CUSTOMER' && v.amount.max_amount < v.amount.min_amount) ctx.addIssue({ code: 'custom', path: ['amount', 'max_amount'], message: 'Maximum must be at least the minimum' });
  });

export const paymentPageStatusSchema = z.strictObject({ status: z.enum(['ACTIVE', 'INACTIVE']) });
export const paymentPageIdSchema = idSchema('pg');

/** A payer starting a payment on a public page. Field values are checked against the page's fields. */
export const startPagePaymentSchema = z.strictObject({
  amount: minAmount.optional(),
  customer: z.strictObject({ name: z.string().trim().min(2, 'Enter your name').max(120), email: emailSchema, mobile: mobileSchema }),
  fields: z.record(z.string().max(30), z.string().trim().max(200)).default({}),
});

// ---- Static QR ----------------------------------------------------------------------------------

export const createStaticQrSchema = z.strictObject({
  label: z.string().trim().min(2, 'Name this QR, e.g. "Counter 1"').max(80),
});

export const staticQrIdSchema = idSchema('sqr');

export const sandboxStaticQrPaySchema = z.strictObject({ amount: minAmount, payer_vpa: z.string().trim().max(100).optional() });
