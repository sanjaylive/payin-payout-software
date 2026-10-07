/* eslint-disable no-console */
/**
 * Load-test fixtures (development only; docs/perf/README.md). Creates LOADTEST merchants with high
 * limits, a funded balance, a verified beneficiary and an API key each, through the real services.
 * Credentials are written to load/k6/.loadtest.env (gitignored) for k6 — never printed.
 *
 *   pnpm --filter @pay2all/api build && node apps/api/dist/scripts/seed-loadtest.js [merchants=4]
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { newId, PERMISSIONS, type PermissionKey } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { Accounts } from '@pay2all/ledger/engine';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from '../app.module';
import { ApiConfig } from '../config/api-config';
import { PRISMA } from '../infra/tokens';
import { ApiKeysService } from '../modules/api-keys/api-keys.service';
import type { Actor } from '../modules/auth/actor';
import { LedgerService } from '../modules/ledger/ledger.service';
import { BeneficiariesService } from '../modules/payouts/beneficiaries.service';

const FUND_MINOR = 10_000_000_000n; // ₹10 crore each
const BIG = 1_000_000_000_000n;

async function main() {
  loadDotenv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to create load-test fixtures in production.');
  const count = Math.max(1, Math.min(20, Number(process.argv[2] ?? 4)));
  const app = await NestFactory.createApplicationContext(AppModule.register(ApiConfig.fromProcessEnv()), { logger: ['error', 'warn'] });
  try {
    const prisma = app.get<PrismaClient>(PRISMA);
    const ledger = app.get(LedgerService);
    const keys = app.get(ApiKeysService);
    const beneficiaries = app.get(BeneficiariesService);
    const platform = await prisma.organization.findUniqueOrThrow({ where: { slug: 'pay2all' } });
    const out: Array<{ merchant_id: string; key: string; secret: string; beneficiary_id: string }> = [];

    for (let i = 1; i <= count; i++) {
      const slug = `loadtest-${i}`;
      let org = await prisma.organization.findUnique({ where: { slug } });
      if (!org) {
        const id = newId('organization');
        org = await prisma.organization.create({ data: { id, slug, name: `Load Test Merchant ${i}`, type: 'MERCHANT', parentId: platform.id } });
        // Approved 400 days ago: these are established merchants, not "new merchant" risk subjects.
        await prisma.merchant.create({ data: { id, status: 'APPROVED', payinEnabled: true, payoutEnabled: true, approvedAt: new Date(Date.now() - 400 * 86_400_000) } });
        await prisma.merchantProfile.create({ data: { merchantId: id, displayName: `Load Test ${i}` } });
        await prisma.merchantKyc.create({ data: { merchantId: id } });
        for (const service of ['PAYIN', 'PAYOUT'] as const) {
          await prisma.limitConfig.create({ data: { id: newId('limitConfig'), level: 'MERCHANT', subjectId: id, service, perTxnMaxMinor: 10_000_000n, dailyAmountMinor: BIG, monthlyAmountMinor: BIG } });
        }
        await ledger.run((tx) =>
          ledger.post(tx, {
            type: 'ADJUSTMENT_CREDIT',
            idempotencyKey: `loadtest-fund:${id}`,
            source: { type: 'ADJUSTMENT', id: `adj_loadtest_${id}` },
            description: 'Load-test funding (development only)',
            lines: [
              { accountCode: Accounts.ADJUSTMENT_SUSPENSE, direction: 'DEBIT', amountMinor: FUND_MINOR, currency: 'INR' },
              { accountCode: Accounts.merchant(id, 'AVAILABLE'), direction: 'CREDIT', amountMinor: FUND_MINOR, currency: 'INR' },
            ],
          }),
        );
      }
      // A synthetic owner actor: the key is issued exactly as the dashboard would, minus the login.
      const actor: Actor = {
        kind: 'user',
        userId: 'usr_loadtest',
        sessionId: 'loadtest',
        organizationId: org.id,
        organizationType: 'MERCHANT',
        organizationParentId: org.parentId,
        roleKeys: ['MERCHANT_OWNER'],
        permissions: new Set(Object.keys(PERMISSIONS) as PermissionKey[]),
        restricted: false,
      };
      // Fresh key per run (old load-test keys are revoked so the active-key cap is never hit).
      await prisma.apiKey.updateMany({ where: { organizationId: org.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
      const key = await keys.create(actor, { name: `loadtest-${randomUUID().slice(0, 8)}` });
      // Above the 6,000/min a merchant can choose: the load generator must not be rate limited.
      await prisma.apiKey.update({ where: { id: key.key_id }, data: { rateLimitPerMinute: 100_000 } }); // the DB maximum

      const { beneficiary } = await beneficiaries.upsert(prisma, org.id, { name: 'Load Test Vendor', type: 'BUSINESS', account_number: `9900${String(i).padStart(4, '0')}12345671`, ifsc: 'HDFC0001234' }, null);
      await prisma.beneficiary.update({ where: { id: beneficiary.id }, data: { verificationStatus: 'VERIFIED', verifiedAt: new Date(), verifiedName: 'LOAD TEST VENDOR' } });
      out.push({ merchant_id: org.id, key: key.public_key, secret: key.secret, beneficiary_id: beneficiary.id });
    }
    // Simulated provider latency for realistic request timing (mock providers only).
    for (const code of ['mock-upi', 'mock-upi-2', 'mock-payout', 'mock-payout-2']) {
      const p = await prisma.provider.findUnique({ where: { code } });
      if (p) await prisma.provider.update({ where: { id: p.id }, data: { config: { ...(p.config as object), latency_ms: Number(process.env.LOADTEST_PROVIDER_LATENCY_MS ?? 80) } } });
    }
    const file = path.resolve(__dirname, '../../../../load/k6/.loadtest.env');
    writeFileSync(file, `PAY2ALL_KEYS=${JSON.stringify(out)}\n`, { mode: 0o600 });
    console.log(`Load-test fixtures ready: ${out.length} merchants. Credentials written to load/k6/.loadtest.env (gitignored).`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
