import { execSync } from 'node:child_process';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

/** Ensure the shared test database has the current schema (never drops data — the API suite owns resets). */
export default function setup(): void {
  loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point at a *_test database');
  execSync('pnpm exec prisma migrate deploy', { cwd: path.resolve(__dirname, '../../../packages/database'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
