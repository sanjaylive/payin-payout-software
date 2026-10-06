import { describe, expect, it } from 'vitest';
import { apiEnvSchema, EnvValidationError, loadEnv, workerEnvSchema } from './env';

const validKey = Buffer.alloc(32, 7).toString('base64');
const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: validKey,
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
};

describe('loadEnv(apiEnvSchema)', () => {
  it('applies defaults for optional values', () => {
    const env = loadEnv(apiEnvSchema, baseEnv);
    expect(env.PORT).toBe(4000);
    expect(env.AUTH_ENFORCE_MFA).toBe(true);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('rejects identical access and refresh secrets', () => {
    expect(() => loadEnv(apiEnvSchema, { ...baseEnv, JWT_REFRESH_SECRET: 'a'.repeat(40) })).toThrow(
      /JWT_REFRESH_SECRET/,
    );
  });

  it('rejects encryption keys that are not 32 bytes', () => {
    expect(() => loadEnv(apiEnvSchema, { ...baseEnv, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(EnvValidationError);
  });

  it('rejects placeholder secrets in production without echoing the value', () => {
    const secretValue = 'replace-with-at-least-32-random-bytes-base64';
    try {
      loadEnv(apiEnvSchema, {
        ...baseEnv,
        NODE_ENV: 'production',
        SWAGGER_ENABLED: 'false',
        JWT_ACCESS_SECRET: secretValue,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as Error).message).toMatch(/JWT_ACCESS_SECRET: placeholder/);
      expect((err as Error).message).not.toContain(secretValue);
    }
  });
});

describe('loadEnv(workerEnvSchema)', () => {
  const worker = { DATABASE_URL: baseEnv.DATABASE_URL, REDIS_URL: baseEnv.REDIS_URL, ENCRYPTION_KEY: validKey, KAFKA_BROKERS: 'localhost:9092' };
  it('requires Kafka brokers', () => {
    expect(() => loadEnv(workerEnvSchema, { ...worker, KAFKA_BROKERS: '' })).toThrow(/KAFKA_BROKERS/);
  });
  it('enforces production safety: SMTP, no private webhook targets, replicated topics', () => {
    const prod = { ...worker, NODE_ENV: 'production' };
    expect(() => loadEnv(workerEnvSchema, prod)).toThrow(/SMTP_URL/);
    expect(() => loadEnv(workerEnvSchema, { ...prod, SMTP_URL: 'smtps://mail', KAFKA_REPLICATION_FACTOR: '3', WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' })).toThrow(/WEBHOOK_ALLOW_PRIVATE_TARGETS/);
    expect(() => loadEnv(workerEnvSchema, { ...prod, SMTP_URL: 'smtps://mail' })).toThrow(/KAFKA_REPLICATION_FACTOR/);
    expect(loadEnv(workerEnvSchema, { ...prod, SMTP_URL: 'smtps://mail', KAFKA_REPLICATION_FACTOR: '3' }).WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe(false);
  });
});

describe('API webhook URL policy', () => {
  it('requires https webhook endpoints in production', () => {
    expect(() => loadEnv(apiEnvSchema, { ...baseEnv, NODE_ENV: 'production', SWAGGER_ENABLED: 'false', S3_SSE: 'AES256', CORS_ALLOWED_ORIGINS: 'https://app.pay2all.in' })).toThrow(/WEBHOOK_REQUIRE_HTTPS/);
  });
});
