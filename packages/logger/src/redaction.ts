/**
 * Keys whose values must never appear in logs, audit diffs or error reports.
 * Matching is case-insensitive on the property name at any depth.
 */
export const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'new_password',
  'currentPassword',
  'current_password',
  'passwordHash',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'mfaToken',
  'mfa_token',
  'otp',
  'secret',
  'secretEncrypted',
  'apiSecret',
  'api_secret',
  'clientSecret',
  'credentials',
  'authorization',
  'cookie',
  'set-cookie',
  'x-pay2all-signature',
  'accountNumber',
  'account_number',
  'accountNumberEncrypted',
  'encryptionKey',
  'tokenHash',
  'otpauthUrl',
  'otpauth_url',
] as const;

const SENSITIVE_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_SET.has(key.toLowerCase());
}

/**
 * Deep-copies a value replacing sensitive keys with "[REDACTED]".
 * Used for audit-log diffs, provider payload persistence and error reporting.
 */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v: unknown) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out as T;
}

/** Pino `redact.paths` covering request/response objects produced by pino-http. */
export const PINO_REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-pay2all-signature"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((k) => (/^[a-zA-Z_][\w]*$/.test(k) ? [k, `*.${k}`, `*.*.${k}`] : [])),
];
