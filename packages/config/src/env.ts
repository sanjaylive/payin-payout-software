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
  /** Direct (non-pooled) connection for LISTEN/NOTIFY — needed if DATABASE_URL goes through
   *  PgBouncer in transaction mode. Empty = use DATABASE_URL. */
  DATABASE_LISTEN_URL: z.string().default(''),
  REDIS_URL: z.url(),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be a base64-encoded 32-byte key'),
  ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9]{1,16}$/, 'must be 1-16 lowercase alphanumerics').default('k1'),
  /** Sentry-protocol DSN for unexpected errors. Empty = error reporting off. */
  SENTRY_DSN: z.string().default(''),
  /** Release identifier attached to error reports and traces (e.g. git SHA). */
  APP_RELEASE: z.string().max(64).default(''),
  /** OTLP/HTTP collector base URL (…/v1/traces is appended). Empty = tracing off. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  /** Fraction of new traces sampled (children follow their parent). */
  OTEL_TRACES_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),
  /** Interface for the internal Prometheus listener; use 0.0.0.0 inside containers. */
  METRICS_HOST: z.string().default('127.0.0.1'),
  /** Optional bearer token Prometheus must present on /metrics. */
  METRICS_TOKEN: z.string().default(''),
};

export const apiEnvSchema = z
  .object({
    ...base,
    PORT: int(4000, 1),
    /** Internal Prometheus port for the API process (0 = off). Never the public port. */
    METRICS_PORT: int(9464),
    /** Internal Prometheus port for the API's jobs process (0 = off). */
    JOBS_METRICS_PORT: int(9465),
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
    /** Sensitive actions need a sign-in or step-up confirmation at most this old (docs/SECURITY.md §1.9). */
    AUTH_STEP_UP_SECONDS: int(300, 30),
    /** Dashboard payouts at or above this many rupees need a fresh step-up. */
    STEP_UP_PAYOUT_MIN_RUPEES: int(50_000, 0),
    /** Passkeys: relying-party id (the web app's registrable domain). Empty = WEB_PUBLIC_URL's host. */
    WEBAUTHN_RP_ID: z.string().default(''),
    /** Break-glass switch for the dashboard IP allowlist (docs/SECURITY.md §1.8). Leave on. */
    DASHBOARD_IP_ALLOWLIST_ENFORCED: bool(true),
    /** Public merchant self sign-up at /signup (docs/ONBOARDING.md). New accounts start as DRAFT merchants. */
    SIGNUP_ENABLED: bool(true),
    /** Optional for the API's jobs process: empty = no Kafka fast path, DB polling only. */
    KAFKA_BROKERS: csv,
    KAFKA_CLIENT_ID: z.string().default('pay2all'),
    /** Webhook endpoints must be https in production; http is accepted elsewhere for local receivers. */
    WEBHOOK_REQUIRE_HTTPS: bool(false),
    /** Which API keys this deployment accepts: a sandbox deployment issues pk_test_ keys, live pk_live_. */
    API_ENVIRONMENT: z.enum(['TEST', 'LIVE']).default('TEST'),
    S3_ENDPOINT: z.string().default(''),
    S3_REGION: z.string().default('ap-south-1'),
    S3_BUCKET: z.string().min(3).default('pay2all-documents'),
    S3_ACCESS_KEY: z.string().default(''),
    S3_SECRET_KEY: z.string().default(''),
    S3_FORCE_PATH_STYLE: bool(false),
    /** Server-side encryption header for uploads (e.g. AES256 or aws:kms). Empty = bucket default. */
    S3_SSE: z.string().default(''),
    MAX_DOCUMENT_BYTES: int(10 * 1024 * 1024, 1024),
    /**
     * Absolute directory the "Local disk" file storage may write under (docs/FILE_STORAGE.md). Empty:
     * <cwd>/.storage outside production; in production, local storage is unavailable until set.
     */
    LOCAL_STORAGE_ROOT: z.string().default(''),
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
    if (!env.S3_SSE) {
      ctx.addIssue({ code: 'custom', path: ['S3_SSE'], message: 'KYC documents must be encrypted at rest in production' });
    }
    if (!env.WEBHOOK_REQUIRE_HTTPS) {
      ctx.addIssue({ code: 'custom', path: ['WEBHOOK_REQUIRE_HTTPS'], message: 'merchant webhook endpoints must be https in production' });
    }
    if (env.METRICS_PORT !== 0 && env.METRICS_PORT === env.PORT) {
      ctx.addIssue({ code: 'custom', path: ['METRICS_PORT'], message: 'metrics must not share the public API port' });
    }
    if (env.CORS_ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ALLOWED_ORIGINS'], message: 'production origins must be https' });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = z
  .object({
    ...base,
    KAFKA_BROKERS: csv,
    KAFKA_CLIENT_ID: z.string().default('pay2all'),
    /** Replication factor for auto-provisioned topics. */
    KAFKA_REPLICATION_FACTOR: int(1, 1),
    WORKER_HEALTH_PORT: int(4001, 1),
    /** Internal Prometheus port for the worker (0 = off). */
    WORKER_METRICS_PORT: int(9466),
    /** Notification email (Mailpit locally). Empty = log-only transport (development/tests). */
    SMTP_URL: z.string().default(''),
    MAIL_FROM: z.string().default('Pay2All Payments <no-reply@pay2all.local>'),
    /** Development only: let webhooks reach private/loopback addresses (local test receivers). */
    WEBHOOK_ALLOW_PRIVATE_TARGETS: bool(false),
  })
  .superRefine((env, ctx) => {
    if (env.KAFKA_BROKERS.length === 0) ctx.addIssue({ code: 'custom', path: ['KAFKA_BROKERS'], message: 'required' });
    if (env.NODE_ENV !== 'production') return;
    if (PLACEHOLDER_PATTERN.test(env.ENCRYPTION_KEY)) ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEY'], message: 'placeholder value not allowed in production' });
    if (!env.SMTP_URL) ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'required in production' });
    if (env.WEBHOOK_ALLOW_PRIVATE_TARGETS) ctx.addIssue({ code: 'custom', path: ['WEBHOOK_ALLOW_PRIVATE_TARGETS'], message: 'never allowed in production (SSRF)' });
    if (env.KAFKA_REPLICATION_FACTOR < 3) ctx.addIssue({ code: 'custom', path: ['KAFKA_REPLICATION_FACTOR'], message: 'must be at least 3 in production' });
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
