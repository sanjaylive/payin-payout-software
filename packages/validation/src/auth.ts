import { z } from 'zod';
import { identifierInputSchema, identifierSchema } from './common';

/** Policy length bounds are enforced here; contextual rules (email/mobile) run server-side. */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export const totpCodeSchema = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const loginSchema = z.strictObject({
  identifier: identifierSchema,
  // Never apply policy at login — only check presence; legacy passwords must still work.
  password: z.string().min(1, 'Enter your password').max(256),
});
export type LoginInput = z.input<typeof loginSchema>;

export const mfaVerifySchema = z.strictObject({
  mfa_token: z.string().min(10).max(2048),
  code: totpCodeSchema,
});
export type MfaVerifyInput = z.input<typeof mfaVerifySchema>;

export const totpEnableSchema = z.strictObject({ code: totpCodeSchema });
export const totpDisableSchema = z.strictObject({
  code: totpCodeSchema,
  password: z.string().min(1).max(256),
});

export const forgotPasswordSchema = z.strictObject({ identifier: identifierSchema });
export type ForgotPasswordInput = z.input<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.strictObject({
  token: z.string().min(20).max(200),
  new_password: passwordSchema,
});
export type ResetPasswordInput = z.input<typeof resetPasswordSchema>;

export const changePasswordSchema = z
  .strictObject({
    current_password: z.string().min(1).max(256),
    new_password: passwordSchema,
  })
  .refine((v) => v.current_password !== v.new_password, {
    path: ['new_password'],
    message: 'New password must be different from the current password',
  });
export type ChangePasswordInput = z.input<typeof changePasswordSchema>;

export const switchOrganizationSchema = z.strictObject({
  organization_id: z.string().min(1).max(40),
});

/** Browser form variants (no transforms; values are submitted as typed). */
export const loginFormSchema = z.object({ identifier: identifierInputSchema, password: z.string().min(1, 'Enter your password').max(256) });
export const forgotPasswordFormSchema = z.object({ identifier: identifierInputSchema });
