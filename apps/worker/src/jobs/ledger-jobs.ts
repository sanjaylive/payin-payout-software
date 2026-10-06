import { newId } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import type { Logger } from '@pay2all/logger';
import type { ScheduledJob } from './scheduler';

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) in IST for an instant. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant of 00:00 IST on a given IST calendar date. */
export function istMidnightUtc(isoDate: string): Date {
  return new Date(new Date(`${isoDate}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
}

interface DriftRow {
  account_id: string;
  code: string;
  owner_id: string | null;
}

/**
 * Hourly balance verification (docs/LEDGER.md §5): drift is never auto-corrected — it is alerted,
 * audited, and the affected merchants' payouts are frozen pending investigation.
 */
export function ledgerVerificationJob(prisma: PrismaClient, logger: Logger): ScheduledJob {
  return {
    name: 'ledger-verify',
    dueKey: (now) => now.toISOString().slice(0, 13), // once per UTC hour
    async run() {
      const drift = await prisma.$queryRaw<DriftRow[]>`SELECT account_id, code, owner_id FROM ledger_verify_balances()`;
      if (drift.length === 0) return;
      const merchantIds = [...new Set(drift.filter((d) => d.code.startsWith('merchant:') && d.owner_id).map((d) => d.owner_id!))];
      logger.error({ accounts: drift.map((d) => d.code), merchantIds }, 'LEDGER DRIFT DETECTED — payouts frozen');
      await prisma.$transaction(async (tx) => {
        if (merchantIds.length) await tx.merchant.updateMany({ where: { id: { in: merchantIds } }, data: { payoutEnabled: false } });
        await tx.auditLog.create({
          data: { id: newId('auditLog'), actorType: 'SYSTEM', action: 'ledger.drift_detected', resourceType: 'ledger', metadata: { accounts: drift.map((d) => d.code), payouts_frozen_for: merchantIds, severity: 'CRITICAL', source: 'scheduled' } },
        });
        await tx.outboxEvent.create({
          data: { id: newId('outboxEvent'), eventType: 'ledger.drift_detected', aggregateType: 'ledger', aggregateId: 'ledger', payload: { accounts: drift.map((d) => d.code), merchant_ids: merchantIds } },
        });
      });
    },
  };
}

/**
 * Daily closing balances at 00:00 IST for the previous IST day. Idempotent (unique per account/day),
 * so re-runs and multiple replicas are harmless.
 */
export function balanceSnapshotJob(prisma: PrismaClient): ScheduledJob {
  return {
    name: 'ledger-snapshot',
    // Due once per IST day, for the day that just closed.
    dueKey: (now) => istDate(now),
    async run(now) {
      await takeSnapshot(prisma, istDate(new Date(now.getTime() - 24 * 3600 * 1000)));
    },
  };
}

export async function takeSnapshot(prisma: PrismaClient, isoDate: string): Promise<number> {
  const cutoff = istMidnightUtc(new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10));
  const rows = await prisma.$queryRaw<{ account_id: string; debits_minor: string; credits_minor: string; balance_minor: string }[]>`
    SELECT account_id, debits_minor::text, credits_minor::text, balance_minor::text FROM ledger_account_balances(${cutoff}::timestamptz)`;
  const result = await prisma.balanceSnapshot.createMany({
    data: rows.map((r) => ({
      id: newId('balanceSnapshot'),
      accountId: r.account_id,
      snapshotDate: new Date(`${isoDate}T00:00:00Z`),
      balanceMinor: BigInt(r.balance_minor),
      debitsMinor: BigInt(r.debits_minor),
      creditsMinor: BigInt(r.credits_minor),
    })),
    skipDuplicates: true,
  });
  return result.count;
}
