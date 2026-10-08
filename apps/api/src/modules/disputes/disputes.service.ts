import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { type Dispute, type DisputeEvidence, isUniqueViolation, notifyInbox, type Payment, type Prisma, type PrismaClient, type TransactionClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { Accounts, type PostingLine } from '@pay2all/ledger/engine';
import { ErrorCode } from '@pay2all/types';
import type { listDisputesQuerySchema, openDisputeSchema, resolveDisputeSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { MerchantEventsService } from '../../infra/merchant-events.service';
import { StorageService } from '../../infra/storage.service';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { inspectImage } from '../brand/image-inspect';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentTransitionsService } from '../payments/payment-transitions.service';

const DISPUTABLE: Payment['status'][] = ['SUCCESS', 'SETTLED', 'PARTIALLY_REFUNDED'];
const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
const EVIDENCE_MAX_FILES = 10;
const GST_MICROS = 180_000n; // 18 % on the chargeback fee
const lienKey = (id: string) => `dispute:${id}:lien`;
const outcomeKey = (id: string) => `dispute:${id}:outcome`;

type LienSources = { available: string; unsettled: string; receivable: string };

/**
 * Disputes and chargebacks (docs/DISPUTES.md). Opening one freezes the amount in the merchant's
 * LIEN bucket (AVAILABLE first, then UNSETTLED, the rest recorded as RECEIVABLE) and moves the
 * payment to DISPUTED. The merchant adds evidence; the platform decides: WON returns the lien to
 * where it came from, LOST sends it to the provider plus any chargeback fee and GST.
 */
@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly transitions: PaymentTransitionsService,
    private readonly events: MerchantEventsService,
    private readonly storage: StorageService,
    private readonly scope: TenantScopeService,
    private readonly audit: AuditService,
  ) {}

  present(d: Dispute, extra: { payment?: Payment | null; evidence?: DisputeEvidence[]; merchantName?: string } = {}) {
    const overdue = d.status === 'OPEN' && d.respondBy.getTime() < Date.now();
    return {
      id: d.id,
      object: 'dispute',
      payment_id: d.paymentId,
      merchant_id: d.merchantId,
      merchant_name: extra.merchantName,
      provider_case_id: d.providerCaseId,
      reason_code: d.reasonCode,
      reason: d.reason,
      amount: minorToMajorString(d.amountMinor),
      status: d.status,
      respond_by: d.respondBy,
      overdue,
      accepted: d.accepted,
      merchant_note: d.merchantNote,
      submitted_at: d.submittedAt,
      fee: minorToMajorString(d.feeMinor),
      tax: minorToMajorString(d.taxMinor),
      resolution_note: d.resolutionNote,
      resolved_at: d.resolvedAt,
      created_at: d.createdAt,
      ...(extra.payment ? { payment: { id: extra.payment.id, merchant_order_id: extra.payment.merchantOrderId, amount: minorToMajorString(extra.payment.amountMinor), method: extra.payment.method, utr: extra.payment.utr, created_at: extra.payment.createdAt, customer_name: extra.payment.customerName } } : {}),
      ...(extra.evidence ? { evidence: extra.evidence.map((e) => ({ id: e.id, file_name: e.fileName, content_type: e.contentType, size_bytes: e.sizeBytes, description: e.description, created_at: e.createdAt })) } : {}),
    };
  }

  private async visible(actor: Actor, id: string) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const d = await this.prisma.dispute.findFirst({ where: { id, ...(ids ? { merchantId: { in: ids } } : {}) } });
    if (!d) throw new AppError(ErrorCode.NOT_FOUND, 'Dispute not found');
    return d;
  }

  async get(actor: Actor, id: string) {
    const d = await this.visible(actor, id);
    const [payment, evidence, org] = await Promise.all([
      this.prisma.payment.findUnique({ where: { id: d.paymentId } }),
      this.prisma.disputeEvidence.findMany({ where: { disputeId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.organization.findUnique({ where: { id: d.merchantId }, select: { name: true } }),
    ]);
    return this.present(d, { payment, evidence, merchantName: org?.name });
  }

  async list(actor: Actor, q: z.output<typeof listDisputesQuerySchema>) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const merchantFilter = q.merchant_id ? (ids && !ids.includes(q.merchant_id) ? { merchantId: '__none__' } : { merchantId: q.merchant_id }) : ids ? { merchantId: { in: ids } } : {};
    const rows = await this.prisma.dispute.findMany({
      where: { AND: [merchantFilter, q.status ? { status: q.status } : {}, keysetAfter(decodeCursor(q.cursor))] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const names = new Map((await this.prisma.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.merchantId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    return toPage(rows, q.limit, (d) => this.present(d, { merchantName: names.get(d.merchantId) }));
  }

  async summary(actor: Actor) {
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const where = ids ? { merchantId: { in: ids } } : {};
    const rows = await this.prisma.dispute.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { amountMinor: true } });
    const by = (s: string) => rows.find((r) => r.status === s);
    const overdue = await this.prisma.dispute.count({ where: { ...where, status: 'OPEN', respondBy: { lt: new Date() } } });
    return {
      open: (by('OPEN')?._count._all ?? 0) + (by('UNDER_REVIEW')?._count._all ?? 0),
      needs_response: by('OPEN')?._count._all ?? 0,
      overdue,
      held_amount: minorToMajorString((by('OPEN')?._sum.amountMinor ?? 0n) + (by('UNDER_REVIEW')?._sum.amountMinor ?? 0n)),
      won: by('WON')?._count._all ?? 0,
      lost: by('LOST')?._count._all ?? 0,
    };
  }

  // ---- Platform: open -----------------------------------------------------------------------------

  private async balance(tx: TransactionClient, merchantId: string, bucket: 'AVAILABLE' | 'UNSETTLED') {
    return (await tx.ledgerAccount.findUnique({ where: { code: Accounts.merchant(merchantId, bucket) }, select: { balanceMinor: true } }))?.balanceMinor ?? 0n;
  }

  async open(actor: Actor, input: z.output<typeof openDisputeSchema>) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    const id = newId('dispute');
    try {
      await this.ledger.run(async (tx) => {
        const p = await this.transitions.lock(tx, input.payment_id);
        if (!DISPUTABLE.includes(p.status)) {
          throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, p.status === 'SETTLEMENT_PENDING' ? 'This payment is being settled right now; open the dispute once the settlement completes' : `A ${p.status.toLowerCase().replace('_', ' ')} payment can't be disputed`);
        }
        const disputable = p.amountMinor - p.refundedAmountMinor;
        const amount = input.amount ?? disputable;
        if (amount > disputable) throw new AppError(ErrorCode.INVALID_REQUEST, `At most ₹${minorToMajorString(disputable)} (captured minus refunded) can be disputed`, [{ path: 'amount', message: 'Too large' }]);

        // Freeze: AVAILABLE first, then UNSETTLED; anything left is owed by the merchant (RECEIVABLE).
        const available = await this.balance(tx, p.merchantId, 'AVAILABLE');
        const fromAvailable = available < amount ? (available > 0n ? available : 0n) : amount;
        const unsettled = await this.balance(tx, p.merchantId, 'UNSETTLED');
        const rest = amount - fromAvailable;
        const fromUnsettled = unsettled < rest ? (unsettled > 0n ? unsettled : 0n) : rest;
        const fromReceivable = rest - fromUnsettled;
        const lines: PostingLine[] = [];
        if (fromAvailable > 0n) lines.push({ accountCode: Accounts.merchant(p.merchantId, 'AVAILABLE'), direction: 'DEBIT', amountMinor: fromAvailable, currency: 'INR' });
        if (fromUnsettled > 0n) lines.push({ accountCode: Accounts.merchant(p.merchantId, 'UNSETTLED'), direction: 'DEBIT', amountMinor: fromUnsettled, currency: 'INR' });
        if (fromReceivable > 0n) lines.push({ accountCode: Accounts.merchant(p.merchantId, 'RECEIVABLE'), direction: 'DEBIT', amountMinor: fromReceivable, currency: 'INR' });
        lines.push({ accountCode: Accounts.merchant(p.merchantId, 'LIEN'), direction: 'CREDIT', amountMinor: amount, currency: 'INR' });
        const posted = await this.ledger.post(tx, { type: 'CHARGEBACK_LIEN', idempotencyKey: lienKey(id), source: { type: 'CHARGEBACK', id }, description: `Dispute on ${p.merchantOrderId}`, metadata: { payment_id: p.id, reason_code: input.reason_code }, lines });

        const before = p.status;
        await this.transitions.transition(tx, p, 'DISPUTED');
        const d = await tx.dispute.create({
          data: {
            id,
            paymentId: p.id,
            merchantId: p.merchantId,
            providerCaseId: input.provider_case_id ?? null,
            reasonCode: input.reason_code,
            reason: input.reason,
            amountMinor: amount,
            respondBy: new Date(Date.now() + input.respond_by_days * 86_400_000),
            paymentStatusBefore: before,
            lienSources: { available: fromAvailable.toString(), unsettled: fromUnsettled.toString(), receivable: fromReceivable.toString() } satisfies LienSources,
            lienJournalId: posted.journalId,
            createdById: actor.userId,
          },
        });
        await this.audit.record({ action: 'dispute.opened', resourceType: 'dispute', resourceId: id, organizationId: p.merchantId, newValue: { payment_id: p.id, amount: minorToMajorString(amount), reason_code: input.reason_code, receivable: minorToMajorString(fromReceivable) }, metadata: { severity: 'HIGH' } }, tx);
        await this.events.emit(tx, p.merchantId, 'dispute.created', id, this.present(d));
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'This payment already has an open dispute');
      throw err;
    }
    return this.get(actor, id);
  }

  // ---- Merchant: evidence, submit, accept --------------------------------------------------------

  private async merchantOpen(actor: Actor, id: string) {
    if (actor.organizationType !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Merchants respond to their disputes');
    const d = await this.visible(actor, id);
    if (d.status !== 'OPEN') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'This dispute is no longer waiting for your response');
    return d;
  }

  async addEvidence(actor: Actor, id: string, file: { buffer: Buffer; size: number; originalname: string } | undefined, description?: string) {
    const d = await this.merchantOpen(actor, id);
    if (!file || file.size === 0) throw new AppError(ErrorCode.INVALID_REQUEST, 'Choose a PDF or image');
    if (file.size > EVIDENCE_MAX_BYTES) throw new AppError(ErrorCode.INVALID_REQUEST, 'Each file can be at most 5 MB');
    if ((await this.prisma.disputeEvidence.count({ where: { disputeId: id } })) >= EVIDENCE_MAX_FILES) throw new AppError(ErrorCode.INVALID_REQUEST, `At most ${EVIDENCE_MAX_FILES} files per dispute`);
    let type = '';
    if (file.buffer.subarray(0, 5).toString('ascii') === '%PDF-') type = 'application/pdf';
    else {
      try {
        type = inspectImage(file.buffer).type;
      } catch {
        type = '';
      }
    }
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new AppError(ErrorCode.INVALID_REQUEST, 'Upload a PDF, PNG, JPEG or WebP file (invoices, delivery proof, chats, terms)');
    const evId = newId('disputeEvidence');
    const key = `disputes/${d.merchantId}/${id}/${evId}`;
    const sha = createHash('sha256').update(file.buffer).digest('hex');
    await this.storage.put(key, file.buffer, type, sha);
    await this.prisma.$transaction(async (tx) => {
      await tx.disputeEvidence.create({ data: { id: evId, disputeId: id, storageKey: key, fileName: file.originalname.replace(/[^\w.\- ]+/g, '_').slice(0, 160) || 'evidence', contentType: type, sizeBytes: file.size, sha256: sha, description: description?.trim().slice(0, 300) || null, uploadedById: actor.userId } });
      await this.audit.record({ action: 'dispute.evidence_added', resourceType: 'dispute', resourceId: id, organizationId: d.merchantId, metadata: { evidence_id: evId, type } }, tx);
    });
    return this.get(actor, id);
  }

  async evidenceFile(actor: Actor, id: string, evidenceId: string): Promise<{ stream: Readable; type: string; name: string }> {
    const d = await this.visible(actor, id);
    const e = await this.prisma.disputeEvidence.findFirst({ where: { id: evidenceId, disputeId: d.id } });
    if (!e) throw new AppError(ErrorCode.NOT_FOUND, 'File not found');
    await this.audit.record({ action: 'dispute.evidence_viewed', resourceType: 'dispute', resourceId: id, organizationId: d.merchantId, metadata: { evidence_id: e.id } });
    return { stream: await this.storage.getStream(e.storageKey), type: e.contentType, name: e.fileName };
  }

  private async platformInbox(tx: Prisma.TransactionClient, d: Dispute, title: string, body: string) {
    const platform = await tx.organization.findFirst({ where: { type: 'PLATFORM' }, select: { id: true } });
    if (platform) await notifyInbox(tx, { organizationId: platform.id, audience: { permission: 'dispute.manage' }, category: 'DISPUTE', severity: 'WARNING', title, body, link: `/admin/disputes?dispute=${d.id}`, resourceType: 'dispute', resourceId: d.id, dedupeKey: `dispute:${d.id}:${title}` });
  }

  async submit(actor: Actor, id: string, note: string) {
    const d = await this.merchantOpen(actor, id);
    if (!(await this.prisma.disputeEvidence.count({ where: { disputeId: id } }))) throw new AppError(ErrorCode.INVALID_REQUEST, 'Attach at least one file before submitting');
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.dispute.updateMany({ where: { id, status: 'OPEN', version: d.version }, data: { status: 'UNDER_REVIEW', merchantNote: note, submittedAt: new Date(), version: { increment: 1 } } });
      if (n.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'The dispute changed; reload and try again');
      const after = await tx.dispute.findUniqueOrThrow({ where: { id } });
      await this.audit.record({ action: 'dispute.submitted', resourceType: 'dispute', resourceId: id, organizationId: d.merchantId }, tx);
      await this.events.emit(tx, d.merchantId, 'dispute.updated', id, this.present(after));
      await this.platformInbox(tx, d, `Dispute evidence submitted — ₹${minorToMajorString(d.amountMinor)}`, `${d.reasonCode} · ready to forward to the bank and decide.`);
    });
    return this.get(actor, id);
  }

  /** The merchant doesn't contest: decided as lost straight away (no chargeback fee). */
  async accept(actor: Actor, id: string, note?: string) {
    const d = await this.merchantOpen(actor, id);
    await this.decide(d, 'LOST', note?.trim() ? `Accepted by merchant: ${note.trim()}` : 'Accepted by merchant', 0n, actor.userId, { accepted: true, merchantNote: note?.trim() || null });
    return this.get(actor, id);
  }

  // ---- Platform: decide ---------------------------------------------------------------------------

  async resolve(actor: Actor, id: string, input: z.output<typeof resolveDisputeSchema>) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    const d = await this.visible(actor, id);
    if (d.status !== 'OPEN' && d.status !== 'UNDER_REVIEW') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'This dispute is already decided');
    await this.decide(d, input.outcome, input.note, input.outcome === 'LOST' ? (input.fee ?? 0n) : 0n, actor.userId);
    return this.get(actor, id);
  }

  private async decide(d: Dispute, outcome: 'WON' | 'LOST', note: string, feeMinor: bigint, userId: string, extra: { accepted?: boolean; merchantNote?: string | null } = {}) {
    const tax = (feeMinor * GST_MICROS) / 1_000_000n;
    await this.ledger.run(async (tx) => {
      const n = await tx.dispute.updateMany({ where: { id: d.id, status: { in: ['OPEN', 'UNDER_REVIEW'] } }, data: { version: { increment: 1 } } });
      if (n.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'This dispute is already decided');
      const p = await this.transitions.lock(tx, d.paymentId);
      const provider = p.providerId ? await tx.provider.findUnique({ where: { id: p.providerId }, select: { code: true } }) : null;
      const src = d.lienSources as LienSources;
      const lines: PostingLine[] = [{ accountCode: Accounts.merchant(d.merchantId, 'LIEN'), direction: 'DEBIT', amountMinor: d.amountMinor, currency: 'INR' }];
      if (outcome === 'WON') {
        // Back to where it was frozen from.
        for (const [bucket, raw] of [['AVAILABLE', src.available], ['UNSETTLED', src.unsettled], ['RECEIVABLE', src.receivable]] as const) {
          if (BigInt(raw) > 0n) lines.push({ accountCode: Accounts.merchant(d.merchantId, bucket), direction: 'CREDIT', amountMinor: BigInt(raw), currency: 'INR' });
        }
      } else {
        if (!provider) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'The payment has no provider to return the money to');
        lines.push({ accountCode: Accounts.providerClearing(provider.code), direction: 'CREDIT', amountMinor: d.amountMinor, currency: 'INR' });
        if (feeMinor > 0n) {
          const available = await this.balance(tx, d.merchantId, 'AVAILABLE');
          const total = feeMinor + tax;
          const fromAvailable = available < total ? (available > 0n ? available : 0n) : total;
          if (fromAvailable > 0n) lines.push({ accountCode: Accounts.merchant(d.merchantId, 'AVAILABLE'), direction: 'DEBIT', amountMinor: fromAvailable, currency: 'INR' });
          if (total - fromAvailable > 0n) lines.push({ accountCode: Accounts.merchant(d.merchantId, 'RECEIVABLE'), direction: 'DEBIT', amountMinor: total - fromAvailable, currency: 'INR' });
          lines.push({ accountCode: Accounts.FEE_REVENUE, direction: 'CREDIT', amountMinor: feeMinor, currency: 'INR' });
          if (tax > 0n) lines.push({ accountCode: Accounts.GST_PAYABLE, direction: 'CREDIT', amountMinor: tax, currency: 'INR' });
        }
      }
      const posted = await this.ledger.post(tx, {
        type: outcome === 'WON' ? 'CHARGEBACK_RELEASE' : 'CHARGEBACK_DEBIT',
        idempotencyKey: outcomeKey(d.id),
        source: { type: 'CHARGEBACK', id: d.id },
        description: `Dispute ${outcome === 'WON' ? 'won' : 'lost'} on ${p.merchantOrderId}`,
        metadata: { payment_id: p.id, fee_minor: feeMinor.toString() },
        lines,
      });
      // The payment returns to its previous state when won (SETTLED if a settlement claimed it while
      // disputed), or ends as CHARGEBACK when lost.
      const restore = p.settlementId && d.paymentStatusBefore === 'SUCCESS' ? 'SETTLED' : d.paymentStatusBefore;
      await this.transitions.transition(tx, p, outcome === 'WON' ? restore : 'CHARGEBACK');
      const after = await tx.dispute.update({ where: { id: d.id }, data: { ...extra, status: outcome, outcomeJournalId: posted.journalId, feeMinor: outcome === 'LOST' ? feeMinor : 0n, taxMinor: outcome === 'LOST' ? tax : 0n, resolutionNote: note, resolvedById: userId, resolvedAt: new Date() } });
      await this.audit.record({ action: `dispute.${outcome === 'WON' ? 'won' : 'lost'}`, resourceType: 'dispute', resourceId: d.id, organizationId: d.merchantId, newValue: { amount: minorToMajorString(d.amountMinor), fee: minorToMajorString(feeMinor), tax: minorToMajorString(tax), journal_id: posted.journalId }, metadata: { note, severity: 'HIGH' } }, tx);
      await this.events.emit(tx, d.merchantId, outcome === 'WON' ? 'dispute.won' : 'dispute.lost', d.id, this.present(after));
    });
  }

  /** Job: remind merchants 2 days before the deadline; tell the platform when a deadline passes. */
  async remindDue(): Promise<number> {
    const now = Date.now();
    const soon = await this.prisma.dispute.findMany({ where: { status: 'OPEN', respondBy: { gt: new Date(now), lt: new Date(now + 2 * 86_400_000) } }, take: 200 });
    const late = await this.prisma.dispute.findMany({ where: { status: 'OPEN', respondBy: { lt: new Date(now) } }, take: 200 });
    await this.prisma.$transaction(async (tx) => {
      for (const d of soon) {
        await notifyInbox(tx, { organizationId: d.merchantId, audience: { permission: 'dispute.respond' }, category: 'DISPUTE', severity: 'CRITICAL', title: `Dispute response due soon — ₹${minorToMajorString(d.amountMinor)}`, body: 'Upload your evidence and submit it before the deadline, or the dispute is decided without it.', link: `/payin/disputes?dispute=${d.id}`, resourceType: 'dispute', resourceId: d.id, dedupeKey: `dispute:${d.id}:due-soon` });
      }
      for (const d of late) await this.platformInbox(tx, d, `Dispute deadline passed — ₹${minorToMajorString(d.amountMinor)}`, `${d.reasonCode} · the merchant didn't respond. Decide it.`);
    });
    if (late.length) this.logger.log({ count: late.length }, 'Disputes past their response deadline');
    return soon.length + late.length;
  }
}
