/* eslint-disable no-console */
/**
 * Development seed. Idempotent — safe to run repeatedly.
 *
 * Never runs in production. Demo users get the password from SEED_PASSWORD, or a freshly generated
 * random password printed once at the end. There are no hardcoded credentials in this repository.
 *
 * Each phase adds its own seed module (merchants, providers, pricing …); demo transactions are
 * created through the real services by apps/api scripts so they carry correct ledger entries.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { checkPasswordPolicy, hashPassword, newId, PERMISSIONS, PERMISSION_KEYS, SYSTEM_ROLES } from '@pay2all/auth';
import { createPrismaClient, type OrganizationType, type PrismaClient } from '../src/index';
import { ensureMerchantAggregates, seedMerchantOnboarding } from './seed-merchants';
import { seedPayoutPolicies } from './seed-payouts';
import { seedPricing } from './seed-pricing';
import { seedProviders } from './seed-providers';
import { seedRiskRules } from './seed-risk';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const prisma = createPrismaClient({ url: databaseUrl, poolMax: 2, applicationName: 'pay2all-seed' });

async function syncPermissionsAndRoles(db: PrismaClient): Promise<Map<string, string>> {
  for (const key of PERMISSION_KEYS) {
    const def = PERMISSIONS[key];
    await db.permission.upsert({
      where: { key },
      create: { key, description: def.description, scopes: [...def.scopes] },
      update: { description: def.description, scopes: [...def.scopes] },
    });
  }

  const roleIds = new Map<string, string>();
  for (const def of SYSTEM_ROLES) {
    const existing = await db.role.findFirst({ where: { key: def.key, organizationId: null }, select: { id: true } });
    const role = existing
      ? await db.role.update({
          where: { id: existing.id },
          data: { name: def.name, description: def.description, scope: def.scope, requiresMfa: def.requiresMfa, isSystem: true },
        })
      : await db.role.create({
          data: {
            id: newId('role'),
            key: def.key,
            name: def.name,
            description: def.description,
            scope: def.scope,
            requiresMfa: def.requiresMfa,
            isSystem: true,
          },
        });
    roleIds.set(def.key, role.id);

    // Make the role's permission set exactly match the code definition.
    await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionKey: { notIn: [...def.permissions] } } });
    await db.rolePermission.createMany({
      data: def.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })),
      skipDuplicates: true,
    });
  }
  return roleIds;
}

async function upsertOrg(db: PrismaClient, slug: string, name: string, type: OrganizationType, parentId: string | null) {
  return db.organization.upsert({
    where: { slug },
    create: { id: newId('organization'), slug, name, type, parentId },
    update: { name, type, parentId },
  });
}

async function upsertUser(
  db: PrismaClient,
  roleIds: Map<string, string>,
  input: { name: string; email: string; mobile?: string; roleKey: string; organizationId: string },
  passwordHash: string,
) {
  const user = await db.user.upsert({
    where: { email: input.email },
    create: {
      id: newId('user'),
      name: input.name,
      email: input.email,
      mobile: input.mobile ?? null,
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
    update: { name: input.name, passwordHash, status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
  });
  const roleId = roleIds.get(input.roleKey);
  if (!roleId) throw new Error(`Unknown role ${input.roleKey}`);
  await db.userRole.upsert({
    where: { userId_roleId_organizationId: { userId: user.id, roleId, organizationId: input.organizationId } },
    create: { id: newId('membership'), userId: user.id, roleId, organizationId: input.organizationId },
    update: {},
  });
  return user;
}

async function main() {
  const password = process.env.SEED_PASSWORD || `Dev-${randomBytes(9).toString('base64url')}!`;
  const policyIssues = checkPasswordPolicy(password);
  if (policyIssues.length) throw new Error(`SEED_PASSWORD violates policy: ${policyIssues.join(', ')}`);
  const passwordHash = await hashPassword(password);

  const roleIds = await syncPermissionsAndRoles(prisma);

  const platform = await upsertOrg(prisma, 'pay2all', 'Pay2All Services Pvt. Ltd.', 'PLATFORM', null);
  const reseller = await upsertOrg(prisma, 'acme-partners', 'Acme Payment Partners', 'RESELLER', platform.id);
  const m1 = await upsertOrg(prisma, 'sharma-electronics', 'Sharma Electronics', 'MERCHANT', reseller.id);
  const m2 = await upsertOrg(prisma, 'kirana-fresh', 'Kirana Fresh Mart', 'MERCHANT', reseller.id);
  const m3 = await upsertOrg(prisma, 'nimbus-software', 'Nimbus Software Pvt. Ltd.', 'MERCHANT', platform.id);

  const users = [
    { name: 'Platform Super Admin', email: 'superadmin@pay2all.local', roleKey: 'SUPER_ADMIN', organizationId: platform.id },
    { name: 'Platform Admin', email: 'admin@pay2all.local', roleKey: 'ADMIN', organizationId: platform.id },
    { name: 'Compliance Officer', email: 'compliance@pay2all.local', roleKey: 'COMPLIANCE', organizationId: platform.id },
    { name: 'Finance Officer', email: 'finance@pay2all.local', roleKey: 'FINANCE', organizationId: platform.id },
    { name: 'Sales Executive', email: 'sales@pay2all.local', roleKey: 'SALES', organizationId: platform.id },
    { name: 'Acme Reseller Admin', email: 'admin@acme-partners.local', roleKey: 'RESELLER', organizationId: reseller.id },
    { name: 'Rohit Sharma', email: 'owner@sharma-electronics.local', mobile: '+919876500001', roleKey: 'MERCHANT_OWNER', organizationId: m1.id },
    { name: 'Priya Verma', email: 'finance@sharma-electronics.local', roleKey: 'MERCHANT_FINANCE', organizationId: m1.id },
    { name: 'Anita Desai', email: 'owner@kirana-fresh.local', mobile: '+919876500002', roleKey: 'MERCHANT_OWNER', organizationId: m2.id },
    { name: 'Vikram Rao', email: 'owner@nimbus-software.local', roleKey: 'MERCHANT_OWNER', organizationId: m3.id },
    { name: 'Nimbus Developer', email: 'dev@nimbus-software.local', roleKey: 'MERCHANT_DEVELOPER', organizationId: m3.id },
  ];
  const created = new Map<string, string>();
  for (const u of users) created.set(u.email, (await upsertUser(prisma, roleIds, u, passwordHash)).id);

  await ensureMerchantAggregates(prisma);
  await seedMerchantOnboarding(prisma, {
    sharma: m1.id,
    kirana: m2.id,
    nimbus: m3.id,
    complianceUserId: created.get('compliance@pay2all.local')!,
    resellerUserId: created.get('admin@acme-partners.local')!,
    nimbusOwnerId: created.get('owner@nimbus-software.local')!,
  });
  await seedProviders(prisma, m1.id);
  await seedPricing(prisma, platform.id);
  await seedPayoutPolicies(prisma);
  await seedRiskRules(prisma);
  const salesId = created.get('sales@pay2all.local')!;
  await prisma.organization.updateMany({ where: { id: { in: [reseller.id, m1.id, m2.id] } }, data: { assignedSalesUserId: salesId } });
  if ((await prisma.salesLead.count()) === 0) {
    const now = new Date();
    await prisma.salesLead.createMany({
      data: [
        { id: newId('salesLead'), companyName: 'Chai Point Cafes', contactName: 'Kabir Mehta', contactEmail: 'kabir@chaipoint.example', source: 'website', expectedMonthlyVolume: '₹25 lakh', status: 'QUALIFIED', assignedSalesUserId: salesId, followUpDate: new Date(now.getTime() + 2 * 86_400_000), notes: [{ at: now.toISOString(), by: salesId, text: 'Wants UPI QR for 12 outlets.' }] },
        { id: newId('salesLead'), companyName: 'Velocity Logistics', contactName: 'Sana Iqbal', contactEmail: 'sana@velocity.example', source: 'referral', expectedMonthlyVolume: '₹1.2 crore', status: 'NEW', assignedSalesUserId: salesId, followUpDate: new Date(now.getTime() + 86_400_000) },
      ],
    });
  }

  await prisma.auditLog.create({
    data: {
      id: newId('auditLog'),
      actorType: 'SYSTEM',
      action: 'system.seeded',
      resourceType: 'system',
      metadata: { organizations: 5, users: users.length, roles: SYSTEM_ROLES.length, permissions: PERMISSION_KEYS.length },
    },
  });

  console.log('\nSeed complete (development only).');
  console.log(`  Permissions: ${PERMISSION_KEYS.length}   System roles: ${SYSTEM_ROLES.length}   Users: ${users.length}`);
  console.log('  Users:');
  for (const u of users) console.log(`    ${u.roleKey.padEnd(20)} ${u.email}`);
  console.log(
    process.env.SEED_PASSWORD
      ? '\n  Password: value of SEED_PASSWORD'
      : `\n  Generated password for all demo users (shown once): ${password}\n  Set SEED_PASSWORD in .env to choose your own.`,
  );
  console.log('  Platform/reseller users must enroll TOTP MFA on first login (AUTH_ENFORCE_MFA=true).\n');
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
