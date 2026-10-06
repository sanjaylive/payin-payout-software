/* eslint-disable no-console */
/**
 * Demo ledger history for Sharma Electronics (development only). Posted through the real engine and
 * Prisma store, so it obeys every ledger rule. Idempotent: journals use deterministic keys.
 *
 * Source ids reference demo payins/payouts; the Payin/Payout phases seed the matching transactions.
 */
import path from 'node:path';
import { newId } from '@pay2all/auth';
import { createPrismaClient } from '@pay2all/database';
import { parseRateMicros, percentOf, taxOn } from '@pay2all/ledger';
import { Accounts, postJournal } from '@pay2all/ledger/engine';
import { config as loadDotenv } from 'dotenv';
import { PrismaLedgerStore } from '../src/modules/ledger/prisma-ledger-store';
import { runLedgerTransaction } from '../src/modules/ledger/ledger-transaction';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo ledger data in production.');
  process.exit(1);
}

const prisma = createPrismaClient({ url: process.env.DATABASE_URL!, poolMax: 2, applicationName: 'pay2all-seed-ledger' });
const INR = 'INR';
const FEE = parseRateMicros('0.18');
const GST = parseRateMicros('18');
const day = (n: number) => new Date(Date.now() - n * 86_400_000);
const rupees = (r: number) => BigInt(Math.round(r * 100)); // literal demo constants only

async function main() {
  const sharma = await prisma.organization.findUnique({ where: { slug: 'sharma-electronics' } });
  if (!sharma) throw new Error('Run the base seed first');
  const M = sharma.id;
  const finance = await prisma.user.findUniqueOrThrow({ where: { email: 'finance@pay2all.local' } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'superadmin@pay2all.local' } });
  const actor = { userId: null, requestId: 'seed' };

  await runLedgerTransaction(prisma, async (tx) => {
    const store = new PrismaLedgerStore(tx);
    const payins = [12_500, 8_999, 45_000, 2_350, 1_50_000, 7_600];
    const nets: bigint[] = [];
    for (const [i, amount] of payins.entries()) {
      const gross = rupees(amount);
      const fee = percentOf(gross, FEE);
      const gst = taxOn(fee, GST);
      nets.push(gross - fee - gst);
      await postJournal(store, {
        type: 'PAYIN_CAPTURE',
        idempotencyKey: `payment:demo_pay_${i + 1}:capture`,
        source: { type: 'PAYMENT', id: `demo_pay_${i + 1}` },
        effectiveAt: day(6 - i),
        description: `UPI collection ₹${amount}`,
        metadata: { demo: 'true' },
        actor,
        lines: [
          { accountCode: Accounts.providerClearing('mock-upi'), direction: 'DEBIT', amountMinor: gross, currency: INR },
          { accountCode: Accounts.merchant(M, 'UNSETTLED'), direction: 'CREDIT', amountMinor: gross - fee - gst, currency: INR },
          { accountCode: Accounts.FEE_REVENUE, direction: 'CREDIT', amountMinor: fee, currency: INR },
          { accountCode: Accounts.GST_PAYABLE, direction: 'CREDIT', amountMinor: gst, currency: INR },
        ],
      });
    }
    const settled = nets.slice(0, 4).reduce((a, b) => a + b, 0n);
    await postJournal(store, {
      type: 'SETTLEMENT', idempotencyKey: 'settlement:demo_stl_1', source: { type: 'SETTLEMENT', id: 'demo_stl_1' }, effectiveAt: day(2), description: 'T+1 settlement to payout wallet', metadata: { demo: 'true' }, actor,
      lines: [
        { accountCode: Accounts.merchant(M, 'UNSETTLED'), direction: 'DEBIT', amountMinor: settled, currency: INR },
        { accountCode: Accounts.merchant(M, 'AVAILABLE'), direction: 'CREDIT', amountMinor: settled, currency: INR },
      ],
    });
    // The spec's payout example: ₹10,000 + ₹5 fee + 18% GST (₹0.90).
    const payout = rupees(10_000);
    const pFee = rupees(5);
    const pGst = taxOn(pFee, GST);
    await postJournal(store, {
      type: 'PAYOUT_RESERVE', idempotencyKey: 'payout:demo_pout_1:reserve', source: { type: 'PAYOUT', id: 'demo_pout_1' }, effectiveAt: day(1), description: 'Vendor payout reserve', metadata: { demo: 'true' }, actor,
      lines: [
        { accountCode: Accounts.merchant(M, 'AVAILABLE'), direction: 'DEBIT', amountMinor: payout + pFee + pGst, currency: INR },
        { accountCode: Accounts.merchant(M, 'RESERVED'), direction: 'CREDIT', amountMinor: payout + pFee + pGst, currency: INR },
      ],
    });
    await postJournal(store, {
      type: 'PAYOUT_SETTLE', idempotencyKey: 'payout:demo_pout_1:settle', source: { type: 'PAYOUT', id: 'demo_pout_1' }, effectiveAt: day(1), description: 'Vendor payout IMPS success', metadata: { demo: 'true' }, actor,
      lines: [
        { accountCode: Accounts.merchant(M, 'RESERVED'), direction: 'DEBIT', amountMinor: payout + pFee + pGst, currency: INR },
        { accountCode: Accounts.providerClearing('mock-payout'), direction: 'CREDIT', amountMinor: payout, currency: INR },
        { accountCode: Accounts.FEE_REVENUE, direction: 'CREDIT', amountMinor: pFee, currency: INR },
        { accountCode: Accounts.GST_PAYABLE, direction: 'CREDIT', amountMinor: pGst, currency: INR },
      ],
    });
    // An in-flight payout (still reserved).
    await postJournal(store, {
      type: 'PAYOUT_RESERVE', idempotencyKey: 'payout:demo_pout_2:reserve', source: { type: 'PAYOUT', id: 'demo_pout_2' }, description: 'Salary payout reserve', metadata: { demo: 'true' }, actor,
      lines: [
        { accountCode: Accounts.merchant(M, 'AVAILABLE'), direction: 'DEBIT', amountMinor: rupees(2_505.9), currency: INR },
        { accountCode: Accounts.merchant(M, 'RESERVED'), direction: 'CREDIT', amountMinor: rupees(2_505.9), currency: INR },
      ],
    });
    await postJournal(store, {
      type: 'LIEN_PLACE', idempotencyKey: 'risk:demo_lien_1:place', source: { type: 'RISK', id: 'demo_lien_1' }, description: 'Risk hold pending dispute review', metadata: { demo: 'true' }, actor,
      lines: [
        { accountCode: Accounts.merchant(M, 'AVAILABLE'), direction: 'DEBIT', amountMinor: rupees(1_000), currency: INR },
        { accountCode: Accounts.merchant(M, 'LIEN'), direction: 'CREDIT', amountMinor: rupees(1_000), currency: INR },
      ],
    });
    // A maker-checker adjustment (finance made it, super admin approved it).
    const existing = await tx.ledgerAdjustment.findFirst({ where: { merchantId: M, reference: 'DEMO-GOODWILL-1' } });
    if (!existing) {
      const adjId = newId('adjustment');
      const posted = await postJournal(store, {
        type: 'ADJUSTMENT_CREDIT', idempotencyKey: `adjustment:${adjId}`, source: { type: 'ADJUSTMENT', id: adjId }, description: 'Goodwill credit for delayed settlement', metadata: { demo: 'true', reference: 'DEMO-GOODWILL-1' }, actor: { userId: admin.id, requestId: 'seed' },
        lines: [
          { accountCode: Accounts.ADJUSTMENT_SUSPENSE, direction: 'DEBIT', amountMinor: rupees(250), currency: INR },
          { accountCode: Accounts.merchant(M, 'AVAILABLE'), direction: 'CREDIT', amountMinor: rupees(250), currency: INR },
        ],
      });
      await tx.ledgerAdjustment.create({
        data: { id: adjId, merchantId: M, direction: 'CREDIT', amountMinor: rupees(250), reason: 'Goodwill credit for delayed settlement', reference: 'DEMO-GOODWILL-1', status: 'POSTED', approvalsRequired: 1, makerId: finance.id, journalId: posted.journalId, postedAt: new Date() },
      });
      await tx.ledgerAdjustmentApproval.create({ data: { id: newId('adjustmentApproval'), adjustmentId: adjId, approverId: admin.id, comment: 'Demo approval' } });
    }
  });

  const balances = await prisma.ledgerAccount.findMany({ where: { ownerId: M }, select: { bucket: true, balanceMinor: true } });
  console.log('  Demo ledger for Sharma Electronics:', balances.map((b) => `${b.bucket}=${b.balanceMinor}`).join(' '));
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
