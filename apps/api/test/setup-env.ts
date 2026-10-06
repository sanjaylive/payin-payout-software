import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

// Integration tests run against the dedicated *_test database and Redis DB 1 — never dev data.
loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.REDIS_URL = `${(process.env.REDIS_URL ?? 'redis://localhost:56379').replace(/\/\d+$/, '')}/1`;
process.env.SMTP_URL = ''; // in-memory mail transport, inspectable by tests
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.TRUST_PROXY_HOPS = '1'; // lets tests vary client IPs via X-Forwarded-For
process.env.LOG_LEVEL = 'silent';
process.env.SWAGGER_ENABLED = 'false';
process.env.AUTH_ENFORCE_MFA = 'true';
process.env.SEED_PASSWORD = 'Test-Seed-Password-2026!';
