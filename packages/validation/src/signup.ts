import { z } from 'zod';
import { passwordSchema } from './auth';
import { emailSchema, mobileSchema } from './common';

/** Merchant self sign-up (docs/ONBOARDING.md §1). Contextual password rules run server-side. */
export const signupStartSchema = z.strictObject({
  name: z.string().trim().min(2, 'Enter your full name').max(120),
  business_name: z.string().trim().min(2, 'Enter your business name').max(120),
  email: emailSchema,
  mobile: mobileSchema,
  password: passwordSchema,
  /** A reseller's referral code (its organization slug). Optional. */
  referral_code: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,80}$/, 'Referral code not recognised').optional(),
  accept_terms: z.literal(true, { error: 'Accept the terms to continue' }),
});
export type SignupStartInput = z.input<typeof signupStartSchema>;

export const signupIdSchema = z.string().regex(/^su_[A-Za-z0-9_-]{20,64}$/, 'Sign-up expired. Start again');

export const signupVerifySchema = z.strictObject({
  signup_id: signupIdSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const signupResendSchema = z.strictObject({ signup_id: signupIdSchema });

export const signupInfoQuerySchema = z.strictObject({
  ref: z.string().trim().toLowerCase().max(80).optional(),
});

/** Browser form variant (no transforms; the server normalises). */
export const signupFormSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name').max(120),
    business_name: z.string().trim().min(2, 'Enter your business name').max(120),
    email: z.email('Enter a valid email address').max(254),
    mobile: z.string().trim().regex(/^(?:\+?91|0)?[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
    password: passwordSchema,
    confirm: z.string(),
    referral_code: z.string().trim().max(80),
    accept_terms: z.boolean().refine((v) => v, 'Accept the terms to continue'),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
