import { Inject, Injectable, Logger } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import type { Prisma, PrismaClient, Settlement, SettlementConfig, TransactionClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { Accounts } from '@pay2all/ledger/engine';
import { ErrorCode } from '@pay2all/types';
import type { listSettlementsQuerySchema, markSettlementPaidSchema, providerRemittanceSchema, settlementConfigSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, toPage } from '../../common/http/paginated';
import { MerchantEventsService } from '../../infra/merchant-events.service';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { LedgerService } from '../ledger/ledger.service';
import { hhmmToMinute, minuteToHHMM, settlementWindow } from './settlement-schedule';

const major = minorToMajorString;
export const SETTLEMENT_BANK_REF = 'nodal';

type ConfigView = Pick<SettlementConfig, 'cycle' | 'customDays' | 'cutoffMinute' | 'minAmountMinor' | 'destination' | 'autoSettle'> & { persisted: boolean };

export type GenerateOutcome =
  | { merchantId: string; result: 'CREATED'; settlementId: string; netMinor: bigint }
  | { merchantId: string; result: 'SKIPPED'; reason: string };

function presentSettlement(s: Settlement) {
  return {
    settlement_id: s.id,
    merchant_id: s.merchantId,
    settlement_date: s.settlementDate,
    cycle: s.cycle,
    destination: s.destination,
    period_start: s.periodStart,
    period_end: s.periodEnd,
    status: s.status,
    payment_count: s.paymentCount,
    gross: major(s.grossMinor),
    fees: major(s.feeMinor),
    tax: major(s.taxMinor),
    refunds: major(s.refundMinor),
    net: major(s.netMinor),
    bank: s.bankSnapshot,
    utr: s.utr,
    bank_reference: s.bankReference,
    failure_reason: s.failureReason,
    processed_at: s.processedAt,
    created_at: s.createdAt,
  };
}

/**
 * Merchant settlements (docs/SETTLEMENT.md). The amount settled is the merchant's UNSETTLED balance
 * minus what is still owed to payments captured after the cutoff — so a settlement can never go
 * negative or take money belonging to later payments, whatever refunds did to the pooled balance.
 * Everything runs under the merchant's UNSETTLED row lock, serialised with captures and refunds.
 */
@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly scope: TenantScopeService,
    private readonly audit: AuditService,
    private readonly events: MerchantEventsService,
    private readonly encryptor: FieldEncryptor,
  ) {}

  // ---- Config ------------------------------------------------------------------------------------

  async configFor(merchantId: string): Promise<ConfigView> {
    const row = await this.prisma.settlementConfig.findUnique({ where: { merchantId } });
    if (row) return { ...row, persisted: true };
    const [profile, bank] = await Promise.all([
      this.prisma.merchantProfile.findUnique({ where: { merchantId }, select: { settlementPreference: true } }),
      this.prisma.merchantBankAccount.count({ where: { merchantId, isActive: true, verificationStatus: 'VERIFIED' } }),
    ]);
    // Defaults: the cycle the merchant asked for at onboarding; bank if a verified account exists.
    return { cycle: profile?.settlementPreference ?? 'T1', customDays: profile?.settlementPreference === 'CUSTOM' ? 3 : null, cutoffMinute: 18 * 60, minAmountMinor: 100n, destination: bank ? 'BANK' : 'WALLET', autoSettle: true, persisted: false };
  }

  presentConfig(c: ConfigView) {
    return { cycle: c.cycle, custom_days: c.customDays, cutoff_time: minuteToHHMM(c.cutoffMinute), min_amount: major(c.minAmountMinor), destination: c.destination, auto_settle: c.autoSettle, is_default: !c.persisted };
  }

  async getConfig(actor: Actor, merchantId: string) {
    await this.assertMerchantVisible(actor, merchantId);
    return this.presentConfig(await this.configFor(merchantId));
  }

  async updateConfig(actor: Actor, merchantId: string, input: z.output<typeof settlementConfigSchema>) {
    const before = await this.configFor(merchantId);
    const data = { cycle: input.cycle, customDays: input.cycle === 'CUSTOM' ? (input.custom_days ?? 3) : null, cutoffMinute: hhmmToMinute(input.cutoff_time), minAmountMinor: input.min_amount, destination: input.destination, autoSettle: input.auto_settle, updatedById: actor.userId };
    const row = await this.prisma.settlementConfig.upsert({ where: { merchantId }, create: { merchantId, ...data }, update: { ...data, version: { increment: 1 } } });
    await this.audit.record({ action: 'settlement.config.updated', resourceType: 'merchant', resourceId: merchantId, organizationId: merchantId, oldValue: this.presentConfig(before), newValue: this.presentConfig({ ...row, persisted: true }), metadata: { reason: input.reason } });
    return this.presentConfig({ ...row, persisted: true });
  }

  // ---- Generation --------------------------------------------------------------------------------

  /** Jobs: generate today's due settlements for every eligible merchant. */
  async generateDue(now = new Date()): Promise<GenerateOutcome[]> {
    const merchants = await this.prisma.$queryRaw<{ merchant_id: string }[]>`
      SELECT DISTINCT merchant_id FROM payments WHERE settlement_id IS NULL AND capture_journal_id IS NOT NULL`;
    const out: GenerateOutcome[] = [];
    for (const { merchant_id } of merchants) {
      try {
        out.push(await this.generateFor(merchant_id, now));
      } catch (err) {
        this.logger.error({ err, merchantId: merchant_id }, 'Settlement generation failed');
        out.push({ merchantId: merchant_id, result: 'SKIPPED', reason: err instanceof Error ? err.message : 'error' });
      }
    }
    return out;
  }

  async generateFor(merchantId: string, now = new Date(), opts: { manual?: boolean; actorId?: string | null } = {}): Promise<GenerateOutcome> {
    const skip = (reason: string): GenerateOutcome => ({ merchantId, result: 'SKIPPED', reason });
    const cfg = await this.configFor(merchantId);
    if (!cfg.autoSettle && !opts.manual) return skip('Automatic settlement is off');
    const { settlementDate, due, periodEnd } = settlementWindow(now, cfg);
    if (!due) return skip('Not due yet (before cutoff)');
    const merchant = await this.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { status: true, resellerId: true } });
    if (merchant.status === 'SUSPENDED') return skip('Merchant is suspended');
    if (await this.prisma.settlementHold.count({ where: { merchantId, releasedAt: null } })) return skip('Settlement hold is active');
    const bank =
      cfg.destination === 'BANK'
        ? await this.prisma.merchantBankAccount.findFirst({ where: { merchantId, isActive: true, verificationStatus: 'VERIFIED' }, orderBy: [{ isPrimary: 'desc' }, { verifiedAt: 'desc' }] })
        : null;
    if (cfg.destination === 'BANK' && !bank) return skip('No verified settlement bank account');

    return this.ledger.run(async (tx) => {
      const unsettledCode = Accounts.merchant(merchantId, 'UNSETTLED');
      const acct = (await tx.$queryRaw<{ id: string; balance_minor: bigint }[]>`SELECT id, balance_minor FROM ledger_accounts WHERE code = ${unsettledCode} FOR UPDATE`)[0];
      if (!acct) return skip('Nothing captured yet');
      if (await tx.settlement.findUnique({ where: { merchantId_settlementDate: { merchantId, settlementDate } } })) return skip('Already settled for this date');

      // What later (post-cutoff) payments still have in the pool: net minus refunds they drew from UNSETTLED.
      const reserveRows = await tx.$queryRaw<{ reserve: bigint }[]>`
        SELECT COALESCE(SUM(GREATEST(p.net_amount_minor - COALESCE(rf.drawn, 0), 0)), 0)::bigint AS reserve
          FROM payments p
          LEFT JOIN LATERAL (
            SELECT SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount_minor ELSE -e.amount_minor END) AS drawn
              FROM refunds r
              JOIN ledger_journals j ON j.source_type = 'REFUND' AND j.source_id = r.id
              JOIN ledger_entries e ON e.journal_id = j.id AND e.account_id = ${acct.id}
             WHERE r.payment_id = p.id) rf ON true
         WHERE p.merchant_id = ${merchantId} AND p.settlement_id IS NULL AND p.capture_journal_id IS NOT NULL AND p.success_at >= ${periodEnd}`;
      const claimed = await tx.$queryRaw<{ id: string; amount_minor: bigint; fee_minor: bigint; tax_minor: bigint }[]>`
        SELECT id, amount_minor, fee_minor, tax_minor FROM payments
         WHERE merchant_id = ${merchantId} AND settlement_id IS NULL AND capture_journal_id IS NOT NULL AND success_at < ${periodEnd}
         FOR UPDATE`;
      const reserve = reserveRows[0]?.reserve ?? 0n;
      const net = acct.balance_minor - reserve > 0n ? acct.balance_minor - reserve : 0n;
      if (claimed.length === 0 && net === 0n) return skip('Nothing to settle');
      if (net > 0n && net < cfg.minAmountMinor) return skip(`Below the minimum settlement amount (₹${major(cfg.minAmountMinor)}); carried forward`);

      const ids = claimed.map((c) => c.id);
      const refunds = ids.length ? await tx.refund.aggregate({ where: { paymentId: { in: ids }, status: { in: ['SUCCESS', 'CREATED', 'PENDING', 'MANUAL_REVIEW'] } }, _sum: { amountMinor: true } }) : { _sum: { amountMinor: 0n } };
      const previous = await tx.settlement.findFirst({ where: { merchantId }, orderBy: { periodEnd: 'desc' }, select: { periodEnd: true } });
      const id = newId('settlement');
      const wallet = cfg.destination === 'WALLET';
      const instant = wallet || net === 0n;
      const now2 = new Date();

      let journalId: string | null = null;
      let transferJournalId: string | null = null;
      if (net > 0n && wallet) {
        journalId = (await this.ledger.post(tx, { type: 'SETTLEMENT', idempotencyKey: `settlement:${id}`, source: { type: 'SETTLEMENT', id }, description: `Settlement ${settlementDate} to wallet`, lines: [
          { accountCode: unsettledCode, direction: 'DEBIT', amountMinor: net, currency: 'INR' },
          { accountCode: Accounts.merchant(merchantId, 'AVAILABLE'), direction: 'CREDIT', amountMinor: net, currency: 'INR' },
        ] })).journalId;
      } else if (net > 0n) {
        // Out of UNSETTLED now, so the same money can't also be refunded while the transfer is in flight.
        transferJournalId = (await this.ledger.post(tx, { type: 'SETTLEMENT_TRANSFER', idempotencyKey: `settlement:${id}:transfer`, source: { type: 'SETTLEMENT', id }, description: `Settlement ${settlementDate} to bank (in transit)`, lines: [
          { accountCode: unsettledCode, direction: 'DEBIT', amountMinor: net, currency: 'INR' },
          { accountCode: Accounts.SETTLEMENT_CLEARING, direction: 'CREDIT', amountMinor: net, currency: 'INR' },
        ] })).journalId;
      }

      const s = await tx.settlement.create({
        data: {
          id,
          merchantId,
          resellerId: merchant.resellerId,
          settlementDate,
          cycle: cfg.cycle,
          destination: cfg.destination,
          periodStart: previous?.periodEnd ?? null,
          periodEnd,
          status: instant ? 'PROCESSED' : 'PROCESSING',
          paymentCount: claimed.length,
          grossMinor: claimed.reduce((a, c) => a + c.amount_minor, 0n),
          feeMinor: claimed.reduce((a, c) => a + c.fee_minor, 0n),
          taxMinor: claimed.reduce((a, c) => a + c.tax_minor, 0n),
          refundMinor: refunds._sum.amountMinor ?? 0n,
          netMinor: net,
          bankAccountId: bank?.id ?? null,
          bankSnapshot: bank ? { account_number_masked: bank.accountNumberMasked, ifsc: bank.ifsc, bank_name: bank.bankName, account_holder_name: bank.accountHolderName } : undefined,
          journalId,
          transferJournalId,
          processedAt: instant ? now2 : null,
          createdById: opts.actorId ?? null,
        },
      });
      if (ids.length) {
        await tx.payment.updateMany({ where: { id: { in: ids } }, data: { settlementId: id, ...(instant ? { settledAt: now2 } : {}) } });
        await tx.payment.updateMany({ where: { id: { in: ids }, status: 'SUCCESS' }, data: { status: 'SETTLEMENT_PENDING', version: { increment: 1 } } });
        if (instant) await tx.payment.updateMany({ where: { id: { in: ids }, status: 'SETTLEMENT_PENDING' }, data: { status: 'SETTLED', version: { increment: 1 } } });
      }
      if (instant) await this.events.emit(tx, merchantId, 'settlement.processed', id, presentSettlement(s));
      await this.audit.record({ action: 'settlement.created', resourceType: 'settlement', resourceId: id, organizationId: merchantId, actor: opts.actorId ? undefined : { type: 'SYSTEM', id: null }, metadata: { date: settlementDate, net: major(net), payments: claimed.length, destination: cfg.destination, manual: Boolean(opts.manual) } }, tx);
      return { merchantId, result: 'CREATED', settlementId: id, netMinor: net } satisfies GenerateOutcome;
    });
  }

  // ---- Bank settlement outcome (finance) ---------------------------------------------------------

  private async lock(tx: TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM settlements WHERE id = ${id} FOR UPDATE`;
    const s = await tx.settlement.findUnique({ where: { id } });
    if (!s) throw new AppError(ErrorCode.NOT_FOUND, 'Settlement not found');
    if (s.status !== 'PROCESSING') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Settlement is already ${s.status.toLowerCase()}`);
    return s;
  }

  async markPaid(actor: Actor, id: string, input: z.output<typeof markSettlementPaidSchema>) {
    const s = await this.ledger.run(async (tx) => {
      const cur = await this.lock(tx, id);
      const paid = await this.ledger.post(tx, { type: 'SETTLEMENT_PAID', idempotencyKey: `settlement:${id}:paid`, source: { type: 'SETTLEMENT', id }, description: `Settlement ${cur.settlementDate} paid (UTR ${input.utr})`, metadata: { utr: input.utr }, lines: [
        { accountCode: Accounts.SETTLEMENT_CLEARING, direction: 'DEBIT', amountMinor: cur.netMinor, currency: 'INR' },
        { accountCode: Accounts.bank(SETTLEMENT_BANK_REF), direction: 'CREDIT', amountMinor: cur.netMinor, currency: 'INR' },
        { accountCode: Accounts.SETTLED_CONTRA, direction: 'DEBIT', amountMinor: cur.netMinor, currency: 'INR' },
        { accountCode: Accounts.merchant(cur.merchantId, 'SETTLED'), direction: 'CREDIT', amountMinor: cur.netMinor, currency: 'INR' },
      ] });
      const now = new Date();
      const res = await tx.settlement.updateMany({ where: { id, version: cur.version, status: 'PROCESSING' }, data: { status: 'PROCESSED', utr: input.utr, bankReference: input.bank_reference ?? null, paidJournalId: paid.journalId, processedAt: now, processedById: actor.userId, version: { increment: 1 } } });
      if (res.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Settlement changed concurrently');
      await tx.payment.updateMany({ where: { settlementId: id }, data: { settledAt: now } });
      await tx.payment.updateMany({ where: { settlementId: id, status: 'SETTLEMENT_PENDING' }, data: { status: 'SETTLED', version: { increment: 1 } } });
      const next = await tx.settlement.findUniqueOrThrow({ where: { id } });
      await this.events.emit(tx, next.merchantId, 'settlement.processed', id, presentSettlement(next));
      await this.audit.record({ action: 'settlement.paid', resourceType: 'settlement', resourceId: id, organizationId: next.merchantId, metadata: { utr: input.utr, net: major(next.netMinor), severity: 'HIGH' } }, tx);
      return next;
    });
    return presentSettlement(s);
  }

  /** The transfer failed or bounced: funds back to UNSETTLED and the payments re-enter the next run. */
  async markFailed(actor: Actor, id: string, reason: string) {
    const s = await this.ledger.run(async (tx) => {
      const cur = await this.lock(tx, id);
      const ret = await this.ledger.post(tx, { type: 'SETTLEMENT_RETURN', idempotencyKey: `settlement:${id}:return`, source: { type: 'SETTLEMENT', id }, description: `Settlement ${cur.settlementDate} returned`, lines: [
        { accountCode: Accounts.SETTLEMENT_CLEARING, direction: 'DEBIT', amountMinor: cur.netMinor, currency: 'INR' },
        { accountCode: Accounts.merchant(cur.merchantId, 'UNSETTLED'), direction: 'CREDIT', amountMinor: cur.netMinor, currency: 'INR' },
      ] });
      const res = await tx.settlement.updateMany({ where: { id, version: cur.version, status: 'PROCESSING' }, data: { status: 'FAILED', failureReason: reason, returnJournalId: ret.journalId, processedAt: new Date(), processedById: actor.userId, version: { increment: 1 } } });
      if (res.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Settlement changed concurrently');
      await tx.payment.updateMany({ where: { settlementId: id, status: 'SETTLEMENT_PENDING' }, data: { status: 'SUCCESS', version: { increment: 1 } } });
      await tx.payment.updateMany({ where: { settlementId: id }, data: { settlementId: null } });
      const next = await tx.settlement.findUniqueOrThrow({ where: { id } });
      await this.events.emit(tx, next.merchantId, 'settlement.failed', id, presentSettlement(next));
      await this.audit.record({ action: 'settlement.failed', resourceType: 'settlement', resourceId: id, organizationId: next.merchantId, metadata: { reason, net: major(next.netMinor), severity: 'HIGH' } }, tx);
      return next;
    });
    return presentSettlement(s);
  }

  /**
   * Bank transfer instructions for PROCESSING bank settlements (finance, MFA session). The only place
   * full account numbers are decrypted for export; every export is audited with the settlement ids.
   */
  async transferFile(actor: Actor): Promise<{ filename: string; csv: string; count: number }> {
    const session = await this.prisma.session.findUnique({ where: { id: actor.sessionId }, select: { mfaVerifiedAt: true } });
    if (!session?.mfaVerifiedAt) throw new AppError(ErrorCode.MFA_ENROLLMENT_REQUIRED);
    const rows = await this.prisma.settlement.findMany({ where: { status: 'PROCESSING', destination: 'BANK' }, orderBy: { createdAt: 'asc' }, take: 500 });
    const accounts = new Map((await this.prisma.merchantBankAccount.findMany({ where: { id: { in: rows.map((r) => r.bankAccountId!).filter(Boolean) } } })).map((a) => [a.id, a]));
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = ['settlement_id,merchant_id,amount,beneficiary_name,account_number,ifsc,narration'];
    for (const r of rows) {
      const a = accounts.get(r.bankAccountId!);
      if (!a) continue;
      const account = this.encryptor.decrypt(a.accountNumberEncrypted, r.merchantId);
      lines.push([r.id, r.merchantId, major(r.netMinor), a.accountHolderName, account, a.ifsc, `PAY2ALL STL ${r.settlementDate}`].map(esc).join(','));
    }
    await this.audit.record({ action: 'settlement.transfer_file.exported', resourceType: 'settlement', resourceId: null, organizationId: null, metadata: { count: lines.length - 1, settlement_ids: rows.map((r) => r.id), severity: 'HIGH' } });
    return { filename: `pay2all-settlements-${new Date().toISOString().slice(0, 10)}.csv`, csv: `${lines.join('\n')}\n`, count: lines.length - 1 };
  }

  // ---- Holds -------------------------------------------------------------------------------------

  async placeHold(actor: Actor, merchantId: string, reason: string) {
    await this.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } }).catch(() => {
      throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    });
    if (await this.prisma.settlementHold.count({ where: { merchantId, releasedAt: null } })) throw new AppError(ErrorCode.CONFLICT, 'A settlement hold is already active');
    const h = await this.prisma.settlementHold.create({ data: { id: newId('settlementHold'), merchantId, reason, placedById: actor.userId } });
    await this.audit.record({ action: 'settlement.hold.placed', resourceType: 'merchant', resourceId: merchantId, organizationId: merchantId, metadata: { reason, severity: 'HIGH' } });
    return { hold_id: h.id, merchant_id: merchantId, reason, placed_at: h.placedAt };
  }

  async releaseHold(actor: Actor, holdId: string, reason: string) {
    const res = await this.prisma.settlementHold.updateMany({ where: { id: holdId, releasedAt: null }, data: { releasedAt: new Date(), releasedById: actor.userId, releaseReason: reason } });
    if (res.count !== 1) throw new AppError(ErrorCode.NOT_FOUND, 'No active hold with that id');
    const h = await this.prisma.settlementHold.findUniqueOrThrow({ where: { id: holdId } });
    await this.audit.record({ action: 'settlement.hold.released', resourceType: 'merchant', resourceId: h.merchantId, organizationId: h.merchantId, metadata: { reason } });
    return { released: true };
  }

  async listHolds(activeOnly: boolean) {
    const rows = await this.prisma.settlementHold.findMany({ where: activeOnly ? { releasedAt: null } : {}, orderBy: { placedAt: 'desc' }, take: 200 });
    const names = new Map((await this.prisma.organization.findMany({ where: { id: { in: rows.map((r) => r.merchantId) } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    return rows.map((h) => ({ hold_id: h.id, merchant_id: h.merchantId, merchant_name: names.get(h.merchantId) ?? null, reason: h.reason, placed_at: h.placedAt, released_at: h.releasedAt, release_reason: h.releaseReason }));
  }

  // ---- Provider remittances (LEDGER.md §4.2) ------------------------------------------------------

  async recordRemittance(actor: Actor, input: z.output<typeof providerRemittanceSchema>) {
    const provider = await this.prisma.provider.findUnique({ where: { id: input.provider_id } });
    if (!provider) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
    const existing = await this.prisma.providerRemittance.findUnique({ where: { providerId_reference: { providerId: provider.id, reference: input.reference } } });
    if (existing) throw new AppError(ErrorCode.DUPLICATE_ORDER, 'This remittance reference was already recorded');
    const id = newId('remittance');
    await this.ledger.run(async (tx) => {
      const lines = [
        { accountCode: Accounts.bank(input.bank_ref), direction: 'DEBIT' as const, amountMinor: input.amount, currency: 'INR' },
        { accountCode: Accounts.providerClearing(provider.code), direction: 'CREDIT' as const, amountMinor: input.amount + input.cost, currency: 'INR' },
      ];
      if (input.cost > 0n) lines.splice(1, 0, { accountCode: Accounts.PROVIDER_COST, direction: 'DEBIT', amountMinor: input.cost, currency: 'INR' });
      const j = await this.ledger.post(tx, { type: 'PROVIDER_SETTLEMENT', idempotencyKey: `provider_stl:${provider.id}:${input.reference}`, source: { type: 'PROVIDER', id: provider.id }, description: `Remittance ${input.reference} from ${provider.name}`, metadata: { value_date: input.value_date }, lines });
      await tx.providerRemittance.create({ data: { id, providerId: provider.id, reference: input.reference, valueDate: input.value_date, amountMinor: input.amount, costMinor: input.cost, bankRef: input.bank_ref, journalId: j.journalId, createdById: actor.userId } });
      await this.audit.record({ action: 'provider.remittance.recorded', resourceType: 'provider', resourceId: provider.id, organizationId: null, metadata: { reference: input.reference, amount: major(input.amount), cost: major(input.cost) } }, tx);
    });
    return { remittance_id: id, provider_id: provider.id, reference: input.reference, amount: major(input.amount), cost: major(input.cost), value_date: input.value_date };
  }

  async listRemittances() {
    const rows = await this.prisma.providerRemittance.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const codes = new Map((await this.prisma.provider.findMany({ select: { id: true, code: true } })).map((p) => [p.id, p.code]));
    return rows.map((r) => ({ remittance_id: r.id, provider: codes.get(r.providerId) ?? r.providerId, reference: r.reference, value_date: r.valueDate, amount: major(r.amountMinor), cost: major(r.costMinor), created_at: r.createdAt }));
  }

  // ---- Reads ---------------------------------------------------------------------------------------

  private async assertMerchantVisible(actor: Actor, merchantId: string) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (ids && !ids.includes(merchantId)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
  }

  async list(actor: Actor, q: z.output<typeof listSettlementsQuerySchema>) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    if (q.merchant_id && ids && !ids.includes(q.merchant_id)) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    const cursor = decodeCursor(q.cursor);
    const where: Prisma.SettlementWhereInput = {
      AND: [
        ids ? (actor.organizationType === 'RESELLER' ? { OR: [{ resellerId: actor.organizationId }, { merchantId: { in: ids } }] } : { merchantId: { in: ids } }) : {},
        q.merchant_id ? { merchantId: q.merchant_id } : {},
        q.status ? { status: q.status } : {},
        q.from || q.to ? { settlementDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {},
        cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {},
      ],
    };
    const rows = await this.prisma.settlement.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1 });
    return toPage(rows, q.limit, presentSettlement);
  }

  async get(actor: Actor, id: string) {
    const s = await this.prisma.settlement.findUnique({ where: { id } });
    if (!s) throw new AppError(ErrorCode.NOT_FOUND, 'Settlement not found');
    await this.assertMerchantVisible(actor, s.merchantId).catch(() => {
      throw new AppError(ErrorCode.NOT_FOUND, 'Settlement not found');
    });
    const payments = await this.prisma.payment.findMany({ where: { settlementId: id }, orderBy: { successAt: 'asc' }, take: 1000, select: { id: true, merchantOrderId: true, amountMinor: true, feeMinor: true, taxMinor: true, netAmountMinor: true, refundedAmountMinor: true, successAt: true, utr: true, status: true } });
    return {
      ...presentSettlement(s),
      payments: payments.map((p) => ({ payment_id: p.id, merchant_order_id: p.merchantOrderId, amount: major(p.amountMinor), fee: major(p.feeMinor), tax: major(p.taxMinor), net: major(p.netAmountMinor), refunded: major(p.refundedAmountMinor), success_at: p.successAt, utr: p.utr, status: p.status })),
    };
  }

  /** Fees and GST charged in an IST month (payins captured + payouts completed), for the Fees page. */
  async feeSummary(actor: Actor, merchantId: string, month: string) {
    await this.assertMerchantVisible(actor, merchantId);
    const start = new Date(Date.parse(`${month}-01T00:00:00+05:30`));
    const next = new Date(start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const [payin, payout, refunds] = await Promise.all([
      this.prisma.payment.aggregate({ where: { merchantId, captureJournalId: { not: null }, successAt: { gte: start, lt: next } }, _sum: { amountMinor: true, feeMinor: true, taxMinor: true }, _count: true }),
      this.prisma.payout.aggregate({ where: { merchantId, settleJournalId: { not: null }, processedAt: { gte: start, lt: next } }, _sum: { amountMinor: true, feeMinor: true, taxMinor: true }, _count: true }),
      this.prisma.refund.aggregate({ where: { merchantId, status: 'SUCCESS', completedAt: { gte: start, lt: next } }, _sum: { amountMinor: true }, _count: true }),
    ]);
    const z = (v: bigint | null) => v ?? 0n;
    const fees = z(payin._sum.feeMinor) + z(payout._sum.feeMinor);
    const tax = z(payin._sum.taxMinor) + z(payout._sum.taxMinor);
    return {
      month,
      payin: { count: payin._count, volume: major(z(payin._sum.amountMinor)), fees: major(z(payin._sum.feeMinor)), gst: major(z(payin._sum.taxMinor)) },
      payout: { count: payout._count, volume: major(z(payout._sum.amountMinor)), fees: major(z(payout._sum.feeMinor)), gst: major(z(payout._sum.taxMinor)) },
      refunds: { count: refunds._count, amount: major(z(refunds._sum.amountMinor)) },
      total_fees: major(fees),
      total_gst: major(tax),
      total_charged: major(fees + tax),
    };
  }

  /** Statement CSV for one settlement (merchant-facing; masked data only). */
  async statementCsv(actor: Actor, id: string) {
    const s = await this.get(actor, id);
    const lines = ['payment_id,merchant_order_id,captured_at,utr,amount,fee,gst,net,refunded'];
    for (const p of s.payments) lines.push([p.payment_id, p.merchant_order_id, p.success_at?.toISOString() ?? '', p.utr ?? '', p.amount, p.fee, p.tax, p.net, p.refunded].join(','));
    lines.push('', `settlement_id,${s.settlement_id}`, `settlement_date,${s.settlement_date}`, `gross,${s.gross}`, `fees,${s.fees}`, `gst,${s.tax}`, `refunds,${s.refunds}`, `net_settled,${s.net}`, `utr,${s.utr ?? ''}`);
    return { filename: `settlement-${s.settlement_date}-${s.settlement_id}.csv`, csv: `${lines.join('\n')}\n` };
  }
}
