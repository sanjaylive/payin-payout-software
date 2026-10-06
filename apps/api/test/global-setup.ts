import { execSync } from 'node:child_process';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import Redis from 'ioredis';
import { Client } from 'pg';

/** Rebuild the test database schema from migrations and seed reference data once per run. */
export default async function globalSetup(): Promise<void> {
  loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for integration tests');
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${dbName}"`);

  const client = new Client({ connectionString: url });
  await client.connect();
  // DROP SCHEMA bypasses the append-only row triggers, which is exactly what a disposable test DB needs.
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();

  const dbPackage = path.resolve(__dirname, '../../../packages/database');
  const env = { ...process.env, DATABASE_URL: url, NODE_ENV: 'test', SEED_PASSWORD: 'Test-Seed-Password-2026!' };
  execSync('pnpm exec prisma migrate deploy', { cwd: dbPackage, env, stdio: 'pipe' });
  execSync('pnpm exec tsx prisma/seed.ts', { cwd: dbPackage, env, stdio: 'pipe' });

  const redis = new Redis(`${(process.env.REDIS_URL ?? 'redis://localhost:56379').replace(/\/\d+$/, '')}/1`);
  await redis.flushdb();
  await redis.quit();
}
