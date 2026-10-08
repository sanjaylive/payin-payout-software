import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';
import { ipFamily } from './ip';

/** Permissions an API key may carry (the public server-to-server surface). */
export const API_KEY_PERMISSIONS = [
  'payin.create',
  'payin.read',
  'payin.refund',
  'payout.create',
  'payout.read',
  'beneficiary.read',
  'beneficiary.manage',
  'settlement.read',
  'ledger.read',
] as const;

export const createApiKeySchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  /** Omitted = every API permission the creator holds. */
  permissions: z.array(z.enum(API_KEY_PERMISSIONS)).min(1).max(API_KEY_PERMISSIONS.length).optional(),
  rate_limit_per_minute: z.number().int().min(1).max(6000).optional(),
});

export const rotateApiKeySchema = z.strictObject({
  /** How long the old key keeps working (0 = revoke immediately). */
  overlap_hours: z.number().int().min(0).max(168).default(24),
});

function isCidr(v: string): boolean {
  const [ip, bits, ...rest] = v.split('/');
  if (rest.length || !ip) return false;
  const family = ipFamily(ip);
  if (!family) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  return family === 4 ? n >= 8 && n <= 32 : n >= 32 && n <= 128;
}

export const ipAllowlistEntrySchema = z.strictObject({
  cidr: z.string().trim().refine(isCidr, 'Enter an IP address or CIDR, e.g. 203.0.113.10 or 203.0.113.0/24 (prefix ≥ /8)'),
  label: z.string().trim().max(80).optional(),
});

/** Dashboard allowlist entry, normalised to explicit CIDR (`203.0.113.10` → `203.0.113.10/32`). */
export const dashboardIpRuleSchema = z.strictObject({
  cidr: z
    .string()
    .trim()
    .refine(isCidr, 'Enter an IP address or CIDR, e.g. 203.0.113.10 or 203.0.113.0/24 (prefix ≥ /8)')
    .transform((v) => (v.includes('/') ? v.toLowerCase() : `${v.toLowerCase()}/${v.includes(':') ? 128 : 32}`)),
  label: z.string().trim().max(80).optional(),
});

export const apiLogsQuerySchema = paginationQuerySchema.extend({
  api_key_id: idSchema('key').optional(),
  status: z.enum(['2xx', '4xx', '5xx']).optional(),
  path: z.string().trim().max(120).optional(),
  merchant_id: idSchema('org').optional(),
});

export const apiUsageQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(90).default(7),
  merchant_id: idSchema('org').optional(),
});
