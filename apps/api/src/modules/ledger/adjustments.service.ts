import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { LedgerAdjustment, LedgerAdjustmentApproval, PrismaClient, TransactionClient } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { Accounts } from '@pay2all/ledger/engine';
import { ErrorCode } from '@pay2all/types';
import type { createAdjustmentSchema, listAdjustmentsQuerySchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { OutboxService } from '../../infra/outbox.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { LimitsService } from '../limits/limits.service';
import { MerchantAccessService } from '../merchants/merchant-access.service';
import { LedgerService } from './ledger.service';

type WithApprovals = LedgerAdjustment & { approvals: LedgerAdjustmentApproval[] };

function present(a: WithApprovals) {
  return {
    id: a.id,
    merchant_id: a.merchantId,
    direction: a.direction,
    amount: minorToMajorString(a.amountMinor),
    currency: a.currency,
    reason: a.reason,
    reference: a.reference,
    supporting_note: a.supportingNote,
    status: a.status,
    approvals_required: a.approvalsRequired,
    approvals: a.approvals.map((x) => ({ approver_id: x.approverId, comment: x.comment, approved_at: x.createdAt })),
    maker_id: a.makerId,
    journal_id: a.journalId,
    rejected_by_id: a.rejectedById,
    rejection_reason: a.rejectionReason,
    posted_at: a.postedAt,
    created_at: a.createdAt,
  };
}

/**
 * Manual balance adjustments (docs/LEDGER.md §4.10, §8). Admins never edit balances: they raise an
 * adjustment, independent checkers approve it, and only then is a balanced journal posted against
 * the adjustment suspense account. Every step is audited.
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly limits: LimitsService,
    private readonly merchants: MerchantAccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async postAdjustment(tx: TransactionClient, adj: LedgerAdjustment) {
    const merchantLine = { accountCode: Accounts.merchant(adj.merchantId, 'AVAILABLE'), amountMinor: adj.amountMinor, currency: adj.currency };
    const suspenseLine = { accountCode: Accounts.ADJUSTMENT_SUSPENSE, amountMinor: adj.amountMinor, currency: adj.currency };
    const credit = adj.direction === 'CREDIT';
    const posted = await this.ledger.post(tx, {
      type: credit ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT',
      idempotencyKey: `adjustment:${adj.id}`,
      source: { type: 'ADJUSTMENT', id: adj.id },
      description: adj.reason,
      metadata: { reason: adj.reason, reference: adj.reference, maker_id: adj.makerId },
      lines: credit
        ? [{ ...suspenseLine, direction: 'DEBIT' }, { ...merchantLine, direction: 'CREDIT' }]
        : [{ ...merchantLine, direction: 'DEBIT' }, { ...suspenseLine, direction: 'CREDIT' }],
    });
    const updated = await tx.ledgerAdjustment.updateMany({
      where: { id: adj.id, status: 'PENDING_APPROVAL', version: adj.version },
      data: { status: 'POSTED', journalId: posted.journalId, postedAt: new Date(), version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Adjustment changed concurrently; reload and retry');
    await this.audit.record({ action: 'ledger.adjustment.posted', resourceType: 'ledger_adjustment', resourceId: adj.id, organizationId: adj.merchantId, newValue: { journal_id: posted.journalId } }, tx);
    await this.outbox.add(tx, { eventType: 'ledger.adjustment_posted', aggregateType: 'ledger_adjustment', aggregateId: adj.id, payload: { adjustment_id: adj.id, merchant_id: adj.merchantId, journal_id: posted.journalId } });
  }

  async create(actor: Actor, input: z.output<typeof createAdjustmentSchema>) {
    const merchant = await this.merchants.require(actor, input.merchant_id);
    if (!['APPROVED', 'SUSPENDED'].includes(merchant.status)) {
      throw new AppError(ErrorCode.MERCHANT_INACTIVE, 'Adjustments apply only to approved (or suspended) merchants');
    }
    const approvalsRequired = await this.limits.approvalsRequiredFor(input.merchant_id, input.amount, 'ADJUSTMENT');
    const id = await this.ledger.run(async (tx) => {
      const adj = await tx.ledgerAdjustment.create({
        data: {
          id: newId('adjustment'),
          merchantId: input.merchant_id,
          direction: input.direction,
          amountMinor: input.amount,
          reason: input.reason,
          reference: input.reference,
          supportingNote: input.supporting_note ?? null,
          approvalsRequired,
          makerId: actor.userId,
        },
      });
      await this.audit.record(
        { action: 'ledger.adjustment.created', resourceType: 'ledger_adjustment', resourceId: adj.id, organizationId: adj.merchantId, newValue: { direction: adj.direction, amount: minorToMajorString(adj.amountMinor), reason: adj.reason, reference: adj.reference, approvals_required: approvalsRequired } },
        tx,
      );
      if (approvalsRequired === 0) await this.postAdjustment(tx, adj);
      return adj.id;
    });
    return this.get(actor, id);
  }

  async approve(actor: Actor, id: string, comment?: string) {
    await this.ledger.run(async (tx) => {
      const adj = await tx.ledgerAdjustment.findUnique({ where: { id } });
      if (!adj) throw new AppError(ErrorCode.NOT_FOUND, 'Adjustment not found');
      await this.merchants.require(actor, adj.merchantId, tx);
      if (adj.status !== 'PENDING_APPROVAL') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Adjustment is ${adj.status.toLowerCase().replace('_', ' ')}`);
      if (adj.makerId === actor.userId) throw new AppError(ErrorCode.SELF_APPROVAL_NOT_ALLOWED, 'The maker of an adjustment cannot approve it');
      try {
        await tx.ledgerAdjustmentApproval.create({ data: { id: newId('adjustmentApproval'), adjustmentId: id, approverId: actor.userId, comment: comment ?? null } });
      } catch {
        throw new AppError(ErrorCode.CONFLICT, 'You have already approved this adjustment');
      }
      await this.audit.record({ action: 'ledger.adjustment.approved', resourceType: 'ledger_adjustment', resourceId: id, organizationId: adj.merchantId, metadata: { comment } }, tx);
      const approvals = await tx.ledgerAdjustmentApproval.count({ where: { adjustmentId: id } });
      // Posting happens in the same transaction: if the debit would overdraw, the approval rolls back too.
      if (approvals >= adj.approvalsRequired) await this.postAdjustment(tx, adj);
    });
    return this.get(actor, id);
  }

  async reject(actor: Actor, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const adj = await tx.ledgerAdjustment.findUnique({ where: { id } });
      if (!adj) throw new AppError(ErrorCode.NOT_FOUND, 'Adjustment not found');
      await this.merchants.require(actor, adj.merchantId, tx);
      const updated = await tx.ledgerAdjustment.updateMany({
        where: { id, status: 'PENDING_APPROVAL', version: adj.version },
        data: { status: adj.makerId === actor.userId ? 'CANCELLED' : 'REJECTED', rejectedById: actor.userId, rejectionReason: reason, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Only pending adjustments can be rejected');
      await this.audit.record({ action: adj.makerId === actor.userId ? 'ledger.adjustment.cancelled' : 'ledger.adjustment.rejected', resourceType: 'ledger_adjustment', resourceId: id, organizationId: adj.merchantId, metadata: { reason } }, tx);
    });
    return this.get(actor, id);
  }

  async get(actor: Actor, id: string) {
    const adj = await this.prisma.ledgerAdjustment.findUnique({ where: { id }, include: { approvals: { orderBy: { createdAt: 'asc' } } } });
    if (!adj) throw new AppError(ErrorCode.NOT_FOUND, 'Adjustment not found');
    await this.merchants.require(actor, adj.merchantId);
    return present(adj);
  }

  async list(actor: Actor, q: z.output<typeof listAdjustmentsQuerySchema>) {
    if (q.merchant_id) await this.merchants.require(actor, q.merchant_id);
    const rows = await this.prisma.ledgerAdjustment.findMany({
      where: { AND: [q.status ? { status: q.status } : {}, q.merchant_id ? { merchantId: q.merchant_id } : {}, keysetAfter(decodeCursor(q.cursor))] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { approvals: { orderBy: { createdAt: 'asc' } } },
    });
    return toPage(rows, q.limit, present);
  }
}
