import { z } from 'zod';

/** White-label brand settings (docs/BRANDING.md). */

export const BRAND_ASSET_KINDS = ['LOGO', 'LOGO_DARK', 'ICON'] as const;
export const BRAND_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon'] as const;
export const BRAND_IMAGE_MAX_BYTES = 1024 * 1024;

export const BRAND_DEFAULTS = {
  product_name: 'Pay2All Payments',
  short_name: 'Pay2All',
  company_name: 'Pay2All Services Pvt. Ltd.',
  tagline: 'Collections, payouts and settlements for Indian businesses.',
  primary_color: null as string | null,
  support_email: null as string | null,
  support_phone: null as string | null,
  website_url: null as string | null,
  login_headline: 'Collections, payouts and settlements — on one reliable ledger.',
  login_subtext: 'Every rupee is double-entry accounted, every action is audited, and every API call is idempotent.',
  footer_text: null as string | null,
};

/** Plain text only: no markup or control characters anywhere a brand string is shown. */
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[<>]/.test(v) && ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'Plain text only (no < > or control characters)');
const optional = (max: number) => text(0, max).transform((v) => v || null).nullable().default(null);

export const saveBrandSchema = z.strictObject({
  product_name: text(2, 60),
  short_name: text(2, 30),
  company_name: text(2, 160),
  tagline: text(0, 160),
  primary_color: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, 'Use a colour like #2563eb')
    .nullable()
    .default(null),
  support_email: z.email('Enter a valid email').max(254).nullable().or(z.literal('').transform(() => null)).default(null),
  support_phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 -]{6,20}$/, 'Digits, spaces, dashes and an optional leading +')
    .nullable()
    .or(z.literal('').transform(() => null))
    .default(null),
  website_url: z
    .url({ protocol: /^https?$/, message: 'Enter a full http(s) URL' })
    .max(300)
    .nullable()
    .or(z.literal('').transform(() => null))
    .default(null),
  login_headline: text(2, 120),
  login_subtext: text(0, 300),
  footer_text: optional(200),
  version: z.number().int().min(0).optional(),
  reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300),
});

export const brandAssetReasonSchema = z.strictObject({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300) });

/** A reseller's own brand: names required; everything else falls back to the platform brand when empty. */
export const saveResellerBrandSchema = z.strictObject({
  product_name: text(2, 60),
  short_name: text(2, 30),
  primary_color: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, 'Use a colour like #2563eb')
    .nullable()
    .or(z.literal('').transform(() => null))
    .default(null),
  support_email: z.email('Enter a valid email').max(254).nullable().or(z.literal('').transform(() => null)).default(null),
  support_phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 -]{6,20}$/, 'Digits, spaces, dashes and an optional leading +')
    .nullable()
    .or(z.literal('').transform(() => null))
    .default(null),
  website_url: z
    .url({ protocol: /^https?$/, message: 'Enter a full http(s) URL' })
    .max(300)
    .nullable()
    .or(z.literal('').transform(() => null))
    .default(null),
  login_headline: optional(120),
  login_subtext: optional(300),
  footer_text: optional(200),
});

/** A host name the reseller controls (no scheme, port or path), e.g. pay.example.com. */
export const customDomainSchema = z.strictObject({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => v.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .refine((v) => /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v) && v.length <= 253, 'Enter a domain like pay.yourcompany.com')
    .refine((v) => !/(^|\.)(localhost|local|internal|test|example)$/.test(v), 'Use a public domain you own'),
});
