/* eslint-disable no-console */
/**
 * Production bootstrap (docs/DEPLOYMENT.md §4). Idempotent: runs on every deploy after
 * `prisma migrate deploy`. Creates only what an empty production database needs:
 *  - permissions and system roles (same as db:sync-rbac);
 *  - the platform organization;
 *  - fail-safe payout approval tiers and the starter risk rules (MONITOR mode);
 *  - the first SUPER_ADMIN, only while none exists, from BOOTSTRAP_ADMIN_EMAIL / _NAME. Its random
 *    password is printed once; two-factor enrolment is forced at first sign-in.
 * Never creates demo users, merchants, gateways or vendors.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { hashPassword, newId } from '@pay2all/auth';
import { createPrismaClient } from '../src/index';
import { syncPermissionsAndRoles } from './rbac';
import { seedPayoutPolicies } from './seed-payouts';
import { seedRiskRules } from './seed-risk';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const prisma = createPrismaClient({ url, poolMax: 1, applicationName: 'pay2all-bootstrap' });

const PLATFORM_SLUG = 'pay2all';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main() {
  const roleIds = await syncPermissionsAndRoles(prisma);
  const platform =
    (await prisma.organization.findFirst({ where: { type: 'PLATFORM' } })) ??
    (await prisma.organization.create({ data: { id: newId('organization'), slug: PLATFORM_SLUG, name: process.env.BOOTSTRAP_PLATFORM_NAME || 'Pay2All Services Pvt. Ltd.', type: 'PLATFORM' } }));
  await seedPayoutPolicies(prisma);
  await seedRiskRules(prisma);

  const superAdminRole = roleIds.get('SUPER_ADMIN');
  if (!superAdminRole) throw new Error('SUPER_ADMIN role missing after RBAC sync');
  const admins = await prisma.userRole.count({ where: { roleId: superAdminRole, user: { status: 'ACTIVE' } } });
  if (admins > 0) {
    console.log(`Bootstrap: up to date (platform ${platform.slug}, ${roleIds.size} roles, ${admins} active super admin(s)).`);
    return;
  }

  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error('No super admin exists yet: set BOOTSTRAP_ADMIN_EMAIL in the server environment.');
  if (await prisma.user.findUnique({ where: { email } })) throw new Error(`${email} already exists but is not an active super admin; fix it by hand rather than overwriting it.`);
  // Random, policy-compliant, shown once. Never logged anywhere else and never stored in plaintext.
  const password = `P2a-${randomBytes(15).toString('base64url')}!9`;
  const user = await prisma.user.create({
    data: { id: newId('user'), name: process.env.BOOTSTRAP_ADMIN_NAME || 'Platform Super Admin', email, passwordHash: await hashPassword(password), status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.userRole.create({ data: { id: newId('membership'), userId: user.id, roleId: superAdminRole, organizationId: platform.id } });
  await prisma.auditLog.create({ data: { id: newId('auditLog'), actorType: 'SYSTEM', action: 'system.bootstrapped', resourceType: 'user', resourceId: user.id, organizationId: platform.id, metadata: { email } } });

  console.log('\n================ FIRST SUPER ADMIN (shown once) ================');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log('  Sign in now, change the password, and enrol two-factor (required).');
  console.log('=================================================================\n');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
