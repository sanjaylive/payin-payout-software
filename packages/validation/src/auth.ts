import { z } from 'zod';
import { identifierInputSchema, identifierSchema } from './common';

/** Policy length bounds are enforced here; contextual rules (email/mobile) run server-side. */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export const totpCodeSchema = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

/**
 * Browser geolocation shared at sign-in (only when the user allowed it). Recorded on the login
 * event; never required. Accuracy in metres as reported by the browser.
 */
export const loginLocationSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(1_000_000).optional(),
});

export const loginSchema = z.strictObject({
  identifier: identifierSchema,
  // Never apply policy at login — only check presence; legacy passwords must still work.
  password: z.string().min(1, 'Enter your password').max(256),
  location: loginLocationSchema.optional(),
});
export type LoginInput = z.input<typeof loginSchema>;

export const recoveryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/, 'Recovery codes look like ABCDE-FGH23');

/** Second login factor: a TOTP code or a single-use recovery code (exactly one). */
export const mfaVerifySchema = z
  .strictObject({
    mfa_token: z.string().min(10).max(2048),
    location: loginLocationSchema.optional(),
    code: totpCodeSchema.optional(),
    recovery_code: recoveryCodeSchema.optional(),
    passkey: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => [v.code, v.recovery_code, v.passkey].filter(Boolean).length === 1, {
    path: ['code'],
    message: 'Provide a 6-digit code, a recovery code or a passkey',
  });

/** Code optional: without one, a recent step-up (e.g. with a passkey) is required instead. */
export const regenerateRecoveryCodesSchema = z.strictObject({ code: totpCodeSchema.optional() });

export const passkeyChallengeSchema = z.strictObject({ mfa_token: z.string().min(10).max(2048) });

export const passkeyRegisterSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name this passkey').max(60),
  response: z.record(z.string(), z.unknown()),
});

export const passkeyRenameSchema = z.strictObject({ name: z.string().trim().min(1).max(60) });

/** Step-up: prove it's still you. Exactly one proof; `password` only for users without two-factor. */
export const stepUpSchema = z
  .strictObject({
    code: totpCodeSchema.optional(),
    recovery_code: recoveryCodeSchema.optional(),
    passkey: z.record(z.string(), z.unknown()).optional(),
    password: z.string().min(1).max(128).optional(),
  })
  .refine((v) => [v.code, v.recovery_code, v.passkey, v.password].filter(Boolean).length === 1, {
    path: ['code'],
    message: 'Provide one way to confirm it is you',
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
