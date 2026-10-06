import { z } from 'zod';

/** Thrown when environment validation fails. Message lists every invalid key (never values). */
export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

const PLACEHOLDER_PATTERN = /replace|changeme|example|placeholder/i;

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const int = (defaultValue: number, min = 0) => z.coerce.number().int().min(min).default(defaultValue);

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const secret = (minLength = 32) =>
  z.string().min(minLength, `must be at least ${minLength} characters`);

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

const base = {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: int(20, 1),
  REDIS_URL: z.url(),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be a base64-encoded 32-byte key'),
  ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9]{1,16}$/, 'must be 1-16 lowercase alphanumerics').default('k1'),
  SENTRY_DSN: z.string().default(''),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
};

export const apiEnvSchema = z
  .object({
    ...base,
    PORT: int(4000, 1),
    API_PUBLIC_URL: z.url().default('http://localhost:4000'),
    WEB_PUBLIC_URL: z.url().default('http://localhost:3000'),
    CORS_ALLOWED_ORIGINS: csv,
    TRUST_PROXY_HOPS: int(0),
    SWAGGER_ENABLED: bool(true),
    JWT_ACCESS_SECRET: secret(),
    JWT_ACCESS_TTL_SECONDS: int(900, 60),
    JWT_REFRESH_SECRET: secret(),
    REFRESH_TOKEN_TTL_SECONDS: int(1_209_600, 3600),
    AUTH_SESSION_IDLE_SECONDS: int(3600, 300),
    AUTH_COOKIE_DOMAIN: z.string().default(''),
    AUTH_ENFORCE_MFA: bool(true),
    AUTH_MAX_FAILED_LOGINS: int(5, 1),
    AUTH_LOCKOUT_SECONDS: int(900, 60),
    SMTP_URL: z.string().default(''),
    MAIL_FROM: z.string().default('Pay2All Payments <no-reply@pay2all.local>'),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY'] as const) {
      if (PLACEHOLDER_PATTERN.test(env[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'placeholder value not allowed in production' });
      }
    }
    if (env.SWAGGER_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['SWAGGER_ENABLED'],
        message: 'public Swagger UI must be disabled in production (serve docs separately)',
      });
    }
    if (env.CORS_ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ALLOWED_ORIGINS'], message: 'production origins must be https' });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = z.object({
  ...base,
  KAFKA_BROKERS: csv,
  KAFKA_CLIENT_ID: z.string().default('pay2all'),
  WORKER_HEALTH_PORT: int(4001, 1),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Validate an environment source against a schema. Error messages include key names and
 * reasons only — never values — so secrets can't leak into boot logs.
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  // Treat empty strings as "unset" so defaults apply uniformly.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}
