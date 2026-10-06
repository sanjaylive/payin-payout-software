/* eslint-disable no-console */
/**
 * Demo payins and payouts for Sharma Electronics (development only). Created through the real services —
 * pricing snapshot, provider call, signed sandbox callback, ledger capture, refund — so the demo
 * data is indistinguishable from real flow output. Idempotent: skipped if demo orders exist.
 *
 * Runs from the compiled build (Nest DI needs decorator metadata): `pnpm seed:demo-payments`.
 */
import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PERMISSIONS, type PermissionKey } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { createPaymentSchema, createPayoutSchema, createRefundSchema } from '@pay2all/validation';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from '../app.module';
import { ApiConfig } from '../config/api-config';
import { PRISMA } from '../infra/tokens';
import type { Actor } from '../modules/auth/actor';
import { PaymentsService } from '../modules/payments/payments.service';
import { RefundsService } from '../modules/payments/refunds.service';
import { SandboxService } from '../modules/provider-events/sandbox.service';
import { BeneficiariesService } from '../modules/payouts/beneficiaries.service';
import { PayoutsService } from '../modules/payouts/payouts.service';

// Amounts script the sandbox: .13 → declined, .50 → stays pending; everything else succeeds.
const DEMO: { amount: string; method: 'UPI_QR' | 'UPI_INTENT' | 'PAYMENT_LINK'; customer: string; outcome: 'SUCCESS' | 'FAILED' | 'OPEN'; refund?: string }[] = [
  { amount: '12500.00', method: 'UPI_QR', customer: 'Neha Kapoor', outcome: 'SUCCESS' },
  { amount: '8999.00', method: 'UPI_INTENT', customer: 'Arjun Mehta', outcome: 'SUCCESS', refund: '1500.00' },
  { amount: '45000.00', method: 'PAYMENT_LINK', customer: 'Kavya Iyer', outcome: 'SUCCESS' },
  { amount: '2350.13', method: 'UPI_QR', customer: 'Rahul Singh', outcome: 'FAILED' },
  { amount: '1499.00', method: 'UPI_QR', customer: 'Sneha Patil', outcome: 'SUCCESS' },
  { amount: '7600.00', method: 'UPI_INTENT', customer: 'Imran Khan', outcome: 'SUCCESS' },
  { amount: '650.13', method: 'UPI_QR', customer: 'Divya Nair', outcome: 'FAILED' },
  { amount: '18999.00', method: 'PAYMENT_LINK', customer: 'Manish Gupta', outcome: 'SUCCESS' },
  { amount: '3200.50', method: 'UPI_QR', customer: 'Pooja Reddy', outcome: 'OPEN' },
];

async function main() {
  loadDotenv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo payments in production.');
  const app = await NestFactory.createApplicationContext(AppModule.register(ApiConfig.fromProcessEnv()), { logger: ['error', 'warn'] });
  try {
    const prisma = app.get<PrismaClient>(PRISMA);
    const sharma = await prisma.organization.findUniqueOrThrow({ where: { slug: 'sharma-electronics' } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'owner@sharma-electronics.local' } });
    const actor: Actor = {
      kind: 'user',
      userId: owner.id,
      sessionId: 'seed',
      organizationId: sharma.id,
      organizationType: 'MERCHANT',
      organizationParentId: sharma.parentId,
      roleKeys: ['MERCHANT_OWNER'],
      permissions: new Set(Object.keys(PERMISSIONS) as PermissionKey[]),
      restricted: false,
    };
    if (await prisma.payment.count({ where: { merchantId: sharma.id, merchantOrderId: { startsWith: 'DEMO-' } } })) {
      console.log('  Demo payments already present — skipped.');
    } else {
      await seedPayins(app, actor);
    }
    if (await prisma.payout.count({ where: { merchantId: sharma.id, merchantOrderId: { startsWith: 'DEMO-PO-' } } })) {
      console.log('  Demo payouts already present — skipped.');
    } else {
      await seedPayouts(app, actor);
    }
  } finally {
    await app.close();
  }
}

type App = Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;

async function seedPayins(app: App, actor: Actor) {
    const payments = app.get(PaymentsService);
    const refunds = app.get(RefundsService);
    const sandbox = app.get(SandboxService, { strict: false });
    let n = 0;
    for (const d of DEMO) {
      n += 1;
      const raw = { merchant_order_id: `DEMO-${String(n).padStart(4, '0')}`, amount: d.amount, method: d.method, customer: { name: d.customer } };
      const res = await payments.create(actor, createPaymentSchema.parse(raw), raw, `seed-demo-${n}`);
      const id = res.payment_id;
      if (d.outcome !== 'OPEN') await sandbox.completePayment(actor, id, d.outcome);
      if (d.refund) {
        const body = { amount: d.refund, reason: 'Customer returned one item' };
        await refunds.create(actor, id, createRefundSchema.parse(body), body, `seed-demo-refund-${n}`);
      }
    }
    console.log(`  Demo payments: ${DEMO.length} for Sharma Electronics (successes, failures, one open, one refund).`);
}

/** Payouts are queued here; the jobs process sends them (run `pnpm dev:jobs`). */
async function seedPayouts(app: App, actor: Actor) {
  const beneficiaries = app.get(BeneficiariesService);
  const payouts = app.get(PayoutsService);
  const vendor = await beneficiaries.create(actor, { name: 'Shree Ganesh Traders', type: 'BUSINESS', account_number: '50100876543219', ifsc: 'HDFC0001234' }).catch(() => null);
  if (vendor) await beneficiaries.verify(actor, vendor.beneficiary_id);
  const list: { order: string; amount: string; mode: 'IMPS' | 'UPI'; beneficiary: Record<string, string>; purpose: 'VENDOR_PAYMENT' | 'SALARY' | 'REFUND_PAYOUT' }[] = [
    { order: 'DEMO-PO-0001', amount: '4500.00', mode: 'IMPS', beneficiary: vendor ? { beneficiary_id: vendor.beneficiary_id } : { name: 'Shree Ganesh Traders', account_number: '50100876543219', ifsc: 'HDFC0001234' }, purpose: 'VENDOR_PAYMENT' },
    { order: 'DEMO-PO-0002', amount: '1200.00', mode: 'UPI', beneficiary: { name: 'Neha Kapoor', upi_id: 'neha.kapoor@okicici' }, purpose: 'REFUND_PAYOUT' },
    { order: 'DEMO-PO-0003', amount: '22000.00', mode: 'IMPS', beneficiary: { name: 'Ravi Kumar', account_number: '30211234567892', ifsc: 'SBIN0004321' }, purpose: 'SALARY' },
  ];
  for (const [i, d] of list.entries()) {
    const raw = { merchant_order_id: d.order, amount: d.amount, mode: d.mode, purpose: d.purpose, beneficiary: d.beneficiary };
    await payouts.create(actor, createPayoutSchema.parse(raw), raw, `seed-demo-payout-${i + 1}`).catch((err: unknown) => console.warn(`  Payout ${d.order} skipped: ${err instanceof Error ? err.message : String(err)}`));
  }
  console.log('  Demo payouts: 2 queued (sent by the jobs process), 1 awaiting approval by a second team member.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
