import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Load the monorepo root .env so `pnpm prisma:*` works from any directory.
loadDotenv({ path: path.resolve(__dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
