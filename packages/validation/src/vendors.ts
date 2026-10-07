import { z } from 'zod';
import { emailSchema, idSchema } from './common';

/**
 * API vendor master (docs/VENDORS.md). A vendor is a company; its payment services are providers
 * and its notification channels are messaging services. Each messaging integration has a strict
 * config schema (non-secret, shown to admins) and a secret schema (encrypted, never shown again).
 */

export const MESSAGING_CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];

/** Which integrations serve which channel. */
export const MESSAGING_ADAPTERS: Record<MessagingChannel, readonly string[]> = {
  EMAIL: ['ses', 'smtp'],
  SMS: ['sms21'],
  WHATSAPP: ['sms21'],
};

const vendorCode = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'Use 2–40 lowercase letters, digits and hyphens');
const httpsUrl = z
  .string()
  .trim()
  .max(200)
  .url()
  .refine((u) => u.startsWith('https://'), 'Must be an https:// URL');
/** Notification template keys (password_reset, invitation, test …). */
const templateKey = z.string().regex(/^[a-z][a-z0-9_]{1,59}$/);

export const createVendorSchema = z.strictObject({
  code: vendorCode,
  name: z.string().trim().min(2).max(120),
  website: httpsUrl.optional(),
  contact_email: emailSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const updateVendorSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  website: httpsUrl.nullable().optional(),
  contact_email: emailSchema.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const linkProviderSchema = z.strictObject({ provider_id: idSchema('prv') });

// ---- Per-integration config and secrets -------------------------------------------------------------

export const sesConfigSchema = z.strictObject({
  region: z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, 'AWS region, e.g. ap-south-1'),
  from_address: emailSchema,
  from_name: z.string().trim().max(80).optional(),
  reply_to: emailSchema.optional(),
  configuration_set: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  /** Use the host's IAM role (EC2/ECS/EKS) instead of stored access keys. */
  use_instance_role: z.boolean().default(false),
});
export const sesSecretSchema = z.strictObject({
  access_key_id: z.string().trim().regex(/^[A-Z0-9]{16,128}$/, 'AWS access key ID'),
  secret_access_key: z.string().trim().min(16).max(128),
});

export const smtpConfigSchema = z.strictObject({
  host: z.string().trim().regex(/^[A-Za-z0-9.-]{1,253}$/, 'Host name'),
  port: z.number().int().min(1).max(65535),
  /** Implicit TLS (465). Port 587 upgrades with STARTTLS when false. */
  secure: z.boolean().default(false),
  from_address: emailSchema,
  from_name: z.string().trim().max(80).optional(),
});
export const smtpSecretSchema = z.strictObject({ username: z.string().min(1).max(254), password: z.string().min(1).max(512) });

const sms21Template = z.strictObject({
  /** sms21 template id (DLT SMS template `tmpl_…` or WhatsApp template `wtpl_…`). */
  template_id: z.string().trim().min(4).max(40),
  /** Variable names the template expects, filled from the notification's variables. */
  variables: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)).max(20).default([]),
});
export const sms21ConfigSchema = z.strictObject({
  base_url: httpsUrl.default('https://api.sms21.in/v1'),
  /** Free-text sender for test keys / non-DLT destinations only (live India SMS uses the template's sender). */
  sender_id: z.string().regex(/^(?:[A-Za-z0-9]{3,11}|\+?[1-9][0-9]{7,14})$/).optional(),
  /** Notification template key → sms21 template. Live SMS in India needs a DLT template for every message. */
  templates: z.record(templateKey, sms21Template).default({}),
});
export const sms21SecretSchema = z.strictObject({
  api_key: z.string().trim().regex(/^sms21_(live|test)_[A-Za-z0-9_-]{8,200}$/, 'An sms21 API key (sms21_live_… or sms21_test_…)'),
});

export const MESSAGING_SCHEMAS = {
  ses: { config: sesConfigSchema, secret: sesSecretSchema },
  smtp: { config: smtpConfigSchema, secret: smtpSecretSchema },
  sms21: { config: sms21ConfigSchema, secret: sms21SecretSchema },
} as const;
export type MessagingAdapter = keyof typeof MESSAGING_SCHEMAS;

export const createMessagingServiceSchema = z
  .strictObject({
    channel: z.enum(MESSAGING_CHANNELS),
    adapter: z.enum(['ses', 'smtp', 'sms21']),
    name: z.string().trim().min(2).max(120),
    priority: z.number().int().min(0).max(1000).default(100),
    config: z.record(z.string(), z.unknown()),
  })
  .superRefine((s, ctx) => {
    if (!MESSAGING_ADAPTERS[s.channel].includes(s.adapter)) {
      ctx.addIssue({ code: 'custom', path: ['adapter'], message: `${s.channel} supports ${MESSAGING_ADAPTERS[s.channel].join(', ')}` });
      return;
    }
    const parsed = MESSAGING_SCHEMAS[s.adapter].config.safeParse(s.config);
    if (!parsed.success) for (const i of parsed.error.issues) ctx.addIssue({ code: 'custom', path: ['config', ...i.path.map(String)], message: i.message });
  });

export const updateMessagingServiceSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(5).max(300),
});

/** Secrets are validated against the service's adapter in the API (the body is adapter-specific). */
export const messagingSecretSchema = z.strictObject({ secret: z.record(z.string(), z.unknown()) });

export const testMessageSchema = z.strictObject({
  /** Email address for EMAIL, mobile in international format for SMS / WhatsApp. */
  to: z.string().trim().min(3).max(254),
});

/** International mobile → digits only, as sms21 expects (919876543210). */
export function toIntlDigits(mobile: string): string | null {
  const digits = mobile.replace(/[\s-]/g, '').replace(/^\+/, '');
  return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null;
}
