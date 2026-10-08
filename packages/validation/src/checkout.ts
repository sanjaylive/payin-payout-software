import { z } from 'zod';
import { emailSchema, idSchema, mobileSchema, paginationQuerySchema } from './common';
import { amountSchema } from './merchant';

/** Hosted checkout and merchant websites (docs/CHECKOUT.md). */

export const addWebsiteSchema = z.strictObject({
  url: z
    .string()
    .trim()
    .max(300)
    .transform((v, ctx) => {
      try {
        const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('bad');
        return u.origin.toLowerCase();
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Enter a website address like https://shop.example.com' });
        return z.NEVER;
      }
    }),
  label: z.string().trim().max(80).optional(),
});

export const reviewWebsiteSchema = z.strictObject({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(300).optional() });

export const createCheckoutSessionSchema = z.strictObject({
  /** Your order reference; one checkout per order id. `#` is reserved. */
  merchant_order_id: z.string().trim().regex(/^[A-Za-z0-9_\-/.:]{1,60}$/, 'Use 1–60 letters, digits or _ - / . :'),
  amount: amountSchema.refine((v) => v >= 100n, 'Minimum amount is ₹1.00'),
  currency: z.literal('INR').default('INR'),
  description: z.string().trim().max(200).optional(),
  customer: z
    .strictObject({ name: z.string().trim().min(1).max(120).optional(), email: emailSchema.optional(), mobile: mobileSchema.optional() })
    .optional(),
  /** Where the customer goes after paying; must be on one of your approved websites. */
  return_url: z.url({ protocol: /^https?$/ }).max(500),
  expires_in_seconds: z.number().int().min(300).max(86_400).default(1800),
  metadata: z
    .record(z.string().regex(/^[\w.-]{1,40}$/), z.string().max(256))
    .refine((m) => Object.keys(m).length <= 20, 'At most 20 metadata keys')
    .default({}),
});

export const listCheckoutSessionsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['OPEN', 'PAID', 'EXPIRED', 'CANCELLED']).optional(),
  merchant_order_id: z.string().max(60).optional(),
});

export const checkoutPaySchema = z.strictObject({
  method: z.enum(['UPI', 'GATEWAY']),
  customer: z.strictObject({
    name: z.string().trim().min(2, 'Enter your name').max(120),
    email: emailSchema,
    mobile: mobileSchema,
  }),
});

export const checkoutSessionIdSchema = idSchema('cs');
export const checkoutTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);
