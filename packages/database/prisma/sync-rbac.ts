/**
 * Deploy step (any environment, including production): sync permissions and system roles from code.
 * Run after `prisma migrate deploy` so new permissions (e.g. dispute.*) reach existing roles.
 *   pnpm --filter @pay2all/database db:sync-rbac
 */
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { createPrismaClient } from '../src/index';
import { syncPermissionsAndRoles } from './rbac';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const prisma = createPrismaClient({ url, poolMax: 1, applicationName: 'pay2all-sync-rbac' });
syncPermissionsAndRoles(prisma)
  .then((roles) => console.log(`Permissions and ${roles.size} system roles are in sync.`))
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
