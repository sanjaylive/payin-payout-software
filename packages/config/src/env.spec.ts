import { describe, expect, it } from 'vitest';
import { apiEnvSchema, EnvValidationError, loadEnv } from './env';

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
