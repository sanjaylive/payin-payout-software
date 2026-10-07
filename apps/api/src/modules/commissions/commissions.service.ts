import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { PrismaClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { Accounts } from '@pay2all/ledger/engine';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { LedgerService } from '../ledger/ledger.service';
import { SETTLEMENT_BANK_REF } from '../settlements/settlements.service';

const major = minorToMajorString;
const IST_MS = 330 * 60_000;

/**
 * Reseller commissions (docs/RESELLERS.md). The reseller's margin on every transaction is fixed in
 * its pricing snapshot (merchant fee − wholesale fee); once money has moved (payin captured, payout
 * completed) the sweeper accrues it — Dr COMMISSION_EXPENSE / Cr reseller COMMISSION_PAYABLE — with
 * key `commission:<txn>`, so each transaction accrues exactly once even across replicas and retries.
 */
@Injectable()
export class CommissionsService {
  private readonly logger = new Logger(CommissionsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /** Jobs: accrue commissions for captured payins and completed payouts not yet accrued. */
  async accrueDue(limit = 200): Promise<number> {
    const due = await this.prisma.$queryRaw<{ id: string; kind: 'PAYMENT' | 'PAYOUT'; reseller_id: string; margin: bigint; merchant_id: string }[]>`
      SELECT p.id, 'PAYMENT' AS kind, p.reseller_id, s.reseller_margin_minor AS margin, p.merchant_id
        FROM payments p JOIN transaction_pricing_snapshots s ON s.transaction_id = p.id
       WHERE p.capture_journal_id IS NOT NULL AND p.reseller_id IS NOT NULL AND s.reseller_margin_minor > 0
         AND NOT EXISTS (SELECT 1 FROM ledger_journals j WHERE j.idempotency_key = 'commission:' || p.id)
      UNION ALL
      SELECT o.id, 'PAYOUT' AS kind, o.reseller_id, s.reseller_margin_minor AS margin, o.merchant_id
        FROM payouts o JOIN transaction_pricing_snapshots s ON s.transaction_id = o.id
       WHERE o.settle_journal_id IS NOT NULL AND o.reseller_id IS NOT NULL AND s.reseller_margin_minor > 0
         AND NOT EXISTS (SELECT 1 FROM ledger_journals j WHERE j.idempotency_key = 'commission:' || o.id)
       LIMIT ${limit}`;
    let n = 0;
    for (const d of due) {
      try {
        await this.ledger.run((tx) =>
          this.ledger.post(tx, {
            type: 'COMMISSION_ACCRUAL',
            idempotencyKey: `commission:${d.id}`,
            source: { type: d.kind, id: d.id },
            description: `Commission on ${d.kind === 'PAYMENT' ? 'payin' : 'payout'} ${d.id}`,
            metadata: { merchant_id: d.merchant_id, reseller_id: d.reseller_id },
            actor: { userId: null, requestId: null },
            lines: [
              { accountCode: Accounts.COMMISSION_EXPENSE, direction: 'DEBIT', amountMinor: d.margin, currency: 'INR' },
              { accountCode: Accounts.resellerCommission(d.reseller_id), direction: 'CREDIT', amountMinor: d.margin, currency: 'INR' },
            ],
          }),
        );
        n++;
      } catch (err) {
        this.logger.error({ err, txn: d.id }, 'Commission accrual failed; will retry');
      }
    }
    return n;
  }

  private assertCanView(actor: Actor, resellerId: string) {
    if (actor.organizationType === 'PLATFORM') return;
    if (actor.organizationType !== 'RESELLER' || actor.organizationId !== resellerId) throw new AppError(ErrorCode.NOT_FOUND, 'Reseller not found');
  }

  async earnings(actor: Actor, resellerId: string, month: string) {
    this.assertCanView(actor, resellerId);
    const reseller = await this.prisma.organization.findFirst({ where: { id: resellerId, type: 'RESELLER' }, select: { id: true, name: true } });
    if (!reseller) throw new AppError(ErrorCode.NOT_FOUND, 'Reseller not found');
    const account = await this.prisma.ledgerAccount.findUnique({ where: { code: Accounts.resellerCommission(resellerId) } });
    const start = new Date(Date.parse(`${month}-01T00:00:00.000Z`) - IST_MS);
    const next = new Date(start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const sums = account
      ? await this.prisma.$queryRaw<{ accrued_month: bigint | null; accrued_total: bigint | null; paid_total: bigint | null }[]>`
          SELECT SUM(e.amount_minor) FILTER (WHERE j.type = 'COMMISSION_ACCRUAL' AND j.effective_at >= ${start} AND j.effective_at < ${next})::bigint AS accrued_month,
                 SUM(e.amount_minor) FILTER (WHERE j.type = 'COMMISSION_ACCRUAL')::bigint AS accrued_total,
                 SUM(e.amount_minor) FILTER (WHERE j.type = 'COMMISSION_PAYOUT')::bigint AS paid_total
            FROM ledger_entries e JOIN ledger_journals j ON j.id = e.journal_id WHERE e.account_id = ${account.id}`
      : [{ accrued_month: 0n, accrued_total: 0n, paid_total: 0n }];
    // Per merchant: margins earned this month (from snapshots of transactions that moved money).
    const byMerchant = await this.prisma.$queryRaw<{ merchant_id: string; name: string; payin_count: bigint; payin_margin: bigint | null; payout_count: bigint; payout_margin: bigint | null }[]>`
      SELECT m.id AS merchant_id, o.name,
             (SELECT COUNT(*) FROM payments p WHERE p.merchant_id = m.id AND p.capture_journal_id IS NOT NULL AND p.success_at >= ${start} AND p.success_at < ${next}) AS payin_count,
             (SELECT SUM(s.reseller_margin_minor)::bigint FROM payments p JOIN transaction_pricing_snapshots s ON s.transaction_id = p.id WHERE p.merchant_id = m.id AND p.capture_journal_id IS NOT NULL AND p.success_at >= ${start} AND p.success_at < ${next}) AS payin_margin,
             (SELECT COUNT(*) FROM payouts p WHERE p.merchant_id = m.id AND p.settle_journal_id IS NOT NULL AND p.processed_at >= ${start} AND p.processed_at < ${next}) AS payout_count,
             (SELECT SUM(s.reseller_margin_minor)::bigint FROM payouts p JOIN transaction_pricing_snapshots s ON s.transaction_id = p.id WHERE p.merchant_id = m.id AND p.settle_journal_id IS NOT NULL AND p.processed_at >= ${start} AND p.processed_at < ${next}) AS payout_margin
        FROM merchants m JOIN organizations o ON o.id = m.id
       WHERE m.reseller_id = ${resellerId}
       ORDER BY o.name`;
    const payouts = await this.prisma.commissionPayout.findMany({ where: { resellerId }, orderBy: { createdAt: 'desc' }, take: 20 });
    const s = sums[0]!;
    return {
      reseller_id: resellerId,
      reseller_name: reseller.name,
      month,
      payable_balance: major(account?.balanceMinor ?? 0n),
      accrued_this_month: major(s.accrued_month ?? 0n),
      accrued_lifetime: major(s.accrued_total ?? 0n),
      paid_lifetime: major(s.paid_total ?? 0n),
      ledger_account_id: account?.id ?? null,
      by_merchant: byMerchant.map((r) => ({ merchant_id: r.merchant_id, name: r.name, payin_count: Number(r.payin_count), payin_margin: major(r.payin_margin ?? 0n), payout_count: Number(r.payout_count), payout_margin: major(r.payout_margin ?? 0n), total: major((r.payin_margin ?? 0n) + (r.payout_margin ?? 0n)) })),
      payouts: payouts.map((p) => ({ payout_id: p.id, amount: major(p.amountMinor), utr: p.utr, period_note: p.periodNote, created_at: p.createdAt })),
    };
  }

  /** Finance records a commission transfer to the reseller (Dr payable / Cr bank). */
  async recordPayout(actor: Actor, resellerId: string, input: { amount: bigint; utr: string; period_note?: string }) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    const reseller = await this.prisma.organization.findFirst({ where: { id: resellerId, type: 'RESELLER' }, select: { id: true } });
    if (!reseller) throw new AppError(ErrorCode.NOT_FOUND, 'Reseller not found');
    if (await this.prisma.commissionPayout.findUnique({ where: { resellerId_utr: { resellerId, utr: input.utr } } })) throw new AppError(ErrorCode.DUPLICATE_ORDER, 'This UTR was already recorded');
    const id = newId('commissionPayout');
    await this.ledger.run(async (tx) => {
      // Engine checks the payable balance under lock: can't pay out more than was accrued.
      const j = await this.ledger.post(tx, {
        type: 'COMMISSION_PAYOUT',
        idempotencyKey: `commission_payout:${id}`,
        source: { type: 'SYSTEM', id },
        description: `Commission payout (UTR ${input.utr})`,
        lines: [
          { accountCode: Accounts.resellerCommission(resellerId), direction: 'DEBIT', amountMinor: input.amount, currency: 'INR' },
          { accountCode: Accounts.bank(SETTLEMENT_BANK_REF), direction: 'CREDIT', amountMinor: input.amount, currency: 'INR' },
        ],
      });
      await tx.commissionPayout.create({ data: { id, resellerId, amountMinor: input.amount, utr: input.utr, periodNote: input.period_note ?? null, journalId: j.journalId, createdById: actor.userId } });
      await this.audit.record({ action: 'commission.payout.recorded', resourceType: 'organization', resourceId: resellerId, organizationId: resellerId, metadata: { amount: major(input.amount), utr: input.utr, severity: 'HIGH' } }, tx);
    });
    return { payout_id: id, reseller_id: resellerId, amount: major(input.amount), utr: input.utr };
  }

  /** Platform overview: every reseller's payable balance. */
  async overview() {
    const rows = await this.prisma.$queryRaw<{ id: string; name: string; balance: bigint | null }[]>`
      SELECT o.id, o.name, a.balance_minor AS balance FROM organizations o
        LEFT JOIN ledger_accounts a ON a.code = 'reseller:' || o.id || ':COMMISSION_PAYABLE'
       WHERE o.type = 'RESELLER' ORDER BY o.name`;
    return rows.map((r) => ({ reseller_id: r.id, name: r.name, payable_balance: major(r.balance ?? 0n) }));
  }
}
