import { z } from 'zod';

/** Indian mobile: optional +91/91/0 prefix followed by 10 digits starting 6-9. Normalised to E.164. */
const MOBILE_RE = /^(?:\+?91|0)?([6-9]\d{9})$/;

export function normalizeMobile(input: string): string | null {
  const match = MOBILE_RE.exec(input.replace(/[\s-]/g, ''));
  return match ? `+91${match[1]}` : null;
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export const emailSchema = z.email('Enter a valid email address').max(254).transform(normalizeEmail);

export const mobileSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const normalized = normalizeMobile(v);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number' });
      return z.NEVER;
    }
    return normalized;
  });

export type LoginIdentifier = { kind: 'email'; value: string } | { kind: 'mobile'; value: string };

/** Accepts an email or a mobile number and returns a tagged, normalised identifier. */
export const identifierSchema = z
  .string()
  .trim()
  .min(3, 'Enter your email or mobile number')
  .max(254)
  .transform((v, ctx): LoginIdentifier => {
    if (v.includes('@')) {
      if (!z.email().safeParse(v).success) {
        ctx.addIssue({ code: 'custom', message: 'Enter a valid email address' });
        return z.NEVER;
      }
      return { kind: 'email', value: normalizeEmail(v) };
    }
    const mobile = normalizeMobile(v);
    if (!mobile) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email or 10-digit mobile number' });
      return z.NEVER;
    }
    return { kind: 'mobile', value: mobile };
  });

/** Prefixed ULID id, e.g. usr_01J... */
export const idSchema = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `Invalid ${prefix} id`);

export const paginationQuerySchema = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Same rules as identifierSchema but without the transform — for browser forms, which must submit
 * the raw string the API expects (the API applies the normalising transform itself).
 */
export const identifierInputSchema = z
  .string()
  .trim()
  .superRefine((v, ctx) => {
    const result = identifierSchema.safeParse(v);
    if (!result.success) ctx.addIssue({ code: 'custom', message: result.error.issues[0]?.message ?? 'Invalid identifier' });
  });
