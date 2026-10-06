import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { DbClient, MerchantStatus, Prisma, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type {
  approveMerchantSchema,
  bankAccountVerificationSchema,
  complianceDecisionSchema,
  merchantSettingsSchema,
  screeningUpdateSchema,
} from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { MailService } from '../../infra/mail.service';
import { OutboxService } from '../../infra/outbox.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { evaluateRequirements, unmet } from './compliance-requirements';
import { MerchantAccessService } from './merchant-access.service';
import { MERCHANT_TRANSITIONS, type MerchantTransition } from './merchant-state';
import { presentBankAccount } from './merchant.presenter';

interface TransitionOptions {
  reason?: string | null;
  notes?: string | null;
  details?: Record<string, unknown>;
  data?: Prisma.MerchantUncheckedUpdateManyInput;
}

const EVENT_BY_ACTION: Record<MerchantTransition, string> = {
  SUBMITTED: 'merchant.submitted',
  REVIEW_STARTED: 'merchant.review_started',
  INFORMATION_REQUESTED: 'merchant.information_requested',
  APPROVED: 'merchant.approved',
  REJECTED: 'merchant.rejected',
  SUSPENDED: 'merchant.suspended',
  REACTIVATED: 'merchant.reactivated',
};

/**
 * Compliance workflow. Every status change:
 *  - is checked against the state machine,
 *  - is applied with a version-checked conditional update (concurrent reviewers can't both win),
 *  - writes an append-only ComplianceReview (who, when, reason, notes), an audit row and an outbox
 *    event — all in one transaction.
 */
@Injectable()
export class ComplianceService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: MerchantAccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly mail: MailService,
  ) {}

  private async transition(tx: DbClient, actor: Actor, merchantId: string, action: MerchantTransition, opts: TransitionOptions = {}): Promise<MerchantStatus> {
    const rule = MERCHANT_TRANSITIONS[action];
    const current = await tx.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { status: true, version: true } });
    if (!rule.from.includes(current.status)) {
      throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Cannot ${action.toLowerCase().replaceAll('_', ' ')} a merchant in status ${current.status}`);
    }
    const updated = await tx.merchant.updateMany({
      where: { id: merchantId, status: current.status, version: current.version },
      data: { ...opts.data, status: rule.to, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'The application changed concurrently; reload and retry');

    await tx.complianceReview.create({
      data: {
        id: newId('complianceReview'),
        merchantId,
        action,
        fromStatus: current.status,
        toStatus: rule.to,
        reviewedById: actor.userId,
        reason: opts.reason ?? null,
        notes: opts.notes ?? null,
        details: (opts.details ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    await this.audit.record(
      { action: EVENT_BY_ACTION[action], resourceType: 'merchant', resourceId: merchantId, organizationId: merchantId, oldValue: { status: current.status }, newValue: { status: rule.to, ...opts.details }, metadata: { reason: opts.reason, notes: opts.notes } },
      tx,
    );
    await this.outbox.add(tx, { eventType: EVENT_BY_ACTION[action], aggregateType: 'merchant', aggregateId: merchantId, version: current.version + 1, payload: { merchant_id: merchantId, from_status: current.status, to_status: rule.to } });
    return rule.to;
  }

  private async assertTransitionAllowed(tx: DbClient, merchantId: string, action: MerchantTransition) {
    const { status } = await tx.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { status: true } });
    if (!MERCHANT_TRANSITIONS[action].from.includes(status)) {
      throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `Cannot ${action.toLowerCase().replaceAll('_', ' ')} a merchant in status ${status}`);
    }
  }

  private async requirements(db: DbClient, merchantId: string) {
    const m = await db.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { status: true, profile: true, kyc: true, persons: true, bankAccounts: { where: { isActive: true } }, documents: true },
    });
    return evaluateRequirements({ ...m, bankAccounts: m.bankAccounts });
  }

  async submit(actor: Actor, merchantId: string) {
    await this.access.require(actor, merchantId);
    await this.prisma.$transaction(async (tx) => {
      await this.assertTransitionAllowed(tx, merchantId, 'SUBMITTED');
      const gaps = unmet(await this.requirements(tx, merchantId), 'SUBMISSION');
      if (gaps.length) {
        throw new AppError(ErrorCode.INVALID_REQUEST, 'The application is incomplete', gaps.map((g) => ({ path: g.key, message: g.label })));
      }
      await this.transition(tx, actor, merchantId, 'SUBMITTED', { data: { submittedAt: new Date() }, reason: 'Submitted for compliance review' });
    });
    return { status: 'SUBMITTED' };
  }

  async startReview(actor: Actor, merchantId: string) {
    await this.access.require(actor, merchantId);
    await this.prisma.$transaction((tx) => this.transition(tx, actor, merchantId, 'REVIEW_STARTED', { reason: 'Review started' }));
    return { status: 'UNDER_REVIEW' };
  }

  async requestInformation(actor: Actor, merchantId: string, input: z.output<typeof complianceDecisionSchema>) {
    await this.access.require(actor, merchantId);
    await this.prisma.$transaction((tx) => this.transition(tx, actor, merchantId, 'INFORMATION_REQUESTED', { reason: input.reason, notes: input.notes ?? null }));
    await this.notifyMerchant(merchantId, 'Action needed on your Pay2All application', `Our compliance team needs more information:\n\n${input.reason}\n\nSign in to Pay2All, update your application under Compliance, and resubmit.`);
    return { status: 'MORE_INFORMATION_REQUIRED' };
  }

  /** Four-eyes rules: whoever submitted (or owns the sales relationship) cannot approve. */
  private async assertIndependentReviewer(tx: DbClient, actor: Actor, merchantId: string) {
    const [lastSubmission, org] = await Promise.all([
      tx.complianceReview.findFirst({ where: { merchantId, action: 'SUBMITTED' }, orderBy: { reviewedAt: 'desc' }, select: { reviewedById: true } }),
      tx.organization.findUniqueOrThrow({ where: { id: merchantId }, select: { assignedSalesUserId: true } }),
    ]);
    if (lastSubmission?.reviewedById === actor.userId || org.assignedSalesUserId === actor.userId) {
      throw new AppError(ErrorCode.SELF_APPROVAL_NOT_ALLOWED, 'An independent reviewer must decide on this application');
    }
  }

  async approve(actor: Actor, merchantId: string, input: z.output<typeof approveMerchantSchema>) {
    await this.access.require(actor, merchantId);
    await this.prisma.$transaction(async (tx) => {
      await this.assertTransitionAllowed(tx, merchantId, 'APPROVED');
      await this.assertIndependentReviewer(tx, actor, merchantId);
      const requirements = await this.requirements(tx, merchantId);
      const gaps = unmet(requirements, 'APPROVAL');
      if (gaps.length) {
        throw new AppError(ErrorCode.KYC_NOT_APPROVED, 'Approval prerequisites are not met', gaps.map((g) => ({ path: g.key, message: g.label })));
      }
      await this.transition(tx, actor, merchantId, 'APPROVED', {
        reason: input.reason,
        notes: input.notes ?? null,
        data: { approvedAt: new Date(), riskCategory: input.risk_category, payinEnabled: input.payin_enabled, payoutEnabled: input.payout_enabled },
        details: { risk_category: input.risk_category, payin_enabled: input.payin_enabled, payout_enabled: input.payout_enabled, checklist: requirements.map((r) => r.key) },
      });
    });
    await this.notifyMerchant(merchantId, 'Your Pay2All account is approved', 'Your business has been approved on Pay2All Payments. Sign in to generate API keys and start accepting payments.');
    return { status: 'APPROVED' };
  }

  async reject(actor: Actor, merchantId: string, input: z.output<typeof complianceDecisionSchema>) {
    await this.access.require(actor, merchantId);
    await this.prisma.$transaction(async (tx) => {
      await this.assertIndependentReviewer(tx, actor, merchantId);
      await this.transition(tx, actor, merchantId, 'REJECTED', { reason: input.reason, notes: input.notes ?? null, data: { payinEnabled: false, payoutEnabled: false } });
    });
    await this.notifyMerchant(merchantId, 'Update on your Pay2All application', 'We are unable to approve your application at this time. Contact your account manager for details.');
    return { status: 'REJECTED' };
  }

  async suspend(actor: Actor, merchantId: string, input: z.output<typeof complianceDecisionSchema>) {
    await this.access.require(actor, merchantId);
    await this.prisma.$transaction((tx) => this.transition(tx, actor, merchantId, 'SUSPENDED', { reason: input.reason, notes: input.notes ?? null }));
    return { status: 'SUSPENDED' };
  }

  async reactivate(actor: Actor, merchantId: string, input: z.output<typeof complianceDecisionSchema>) {
    await this.access.require(actor, merchantId);
    await this.prisma.$transaction((tx) => this.transition(tx, actor, merchantId, 'REACTIVATED', { reason: input.reason, notes: input.notes ?? null }));
    return { status: 'APPROVED' };
  }

  async updateScreening(actor: Actor, merchantId: string, input: z.output<typeof screeningUpdateSchema>) {
    const merchant = await this.access.require(actor, merchantId);
    if (merchant.status === 'DRAFT' || merchant.status === 'REJECTED') {
      throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Screening is recorded once the application has been submitted');
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.merchantKyc.findUniqueOrThrow({ where: { merchantId } });
      const after = await tx.merchantKyc.update({
        where: { merchantId },
        data: {
          ...(input.sanctions_status ? { sanctionsStatus: input.sanctions_status } : {}),
          ...(input.pep_status ? { pepStatus: input.pep_status } : {}),
          ...(input.adverse_media_status ? { adverseMediaStatus: input.adverse_media_status } : {}),
          ...(input.notes !== undefined ? { riskNotes: input.notes } : {}),
          screenedAt: new Date(),
          screenedById: actor.userId,
        },
      });
      if (input.risk_category) await tx.merchant.update({ where: { id: merchantId }, data: { riskCategory: input.risk_category } });
      await this.audit.record(
        {
          action: 'merchant.screening.updated',
          resourceType: 'merchant',
          resourceId: merchantId,
          organizationId: merchantId,
          oldValue: { sanctions: before.sanctionsStatus, pep: before.pepStatus, adverse_media: before.adverseMediaStatus, risk_category: merchant.riskCategory },
          newValue: { sanctions: after.sanctionsStatus, pep: after.pepStatus, adverse_media: after.adverseMediaStatus, risk_category: input.risk_category ?? merchant.riskCategory },
        },
        tx,
      );
    });
    return { updated: true };
  }

  async verifyBankAccount(actor: Actor, merchantId: string, accountId: string, input: z.output<typeof bankAccountVerificationSchema>) {
    await this.access.require(actor, merchantId);
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.merchantBankAccount.findFirst({ where: { id: accountId, merchantId, isActive: true } });
      if (!account) throw new AppError(ErrorCode.NOT_FOUND, 'Bank account not found');
      if (account.createdById === actor.userId) throw new AppError(ErrorCode.SELF_APPROVAL_NOT_ALLOWED, 'You cannot verify an account you added');
      const updated = await tx.merchantBankAccount.update({
        where: { id: accountId },
        data: { verificationStatus: input.status, verificationReference: input.reference, verifiedById: actor.userId, verifiedAt: new Date() },
      });
      await this.audit.record(
        { action: `merchant.bank_account.${input.status === 'VERIFIED' ? 'verified' : 'verification_failed'}`, resourceType: 'merchant_bank_account', resourceId: accountId, organizationId: merchantId, oldValue: { status: account.verificationStatus }, newValue: { status: input.status, reference: input.reference }, metadata: { notes: input.notes } },
        tx,
      );
      return presentBankAccount(updated);
    });
  }

  /** Post-approval service switches (enable/disable payin & payout, risk category). */
  async updateSettings(actor: Actor, merchantId: string, input: z.output<typeof merchantSettingsSchema>) {
    const merchant = await this.access.require(actor, merchantId);
    const enabling = input.payin_enabled === true || input.payout_enabled === true;
    if (enabling && merchant.status !== 'APPROVED') {
      throw new AppError(ErrorCode.KYC_NOT_APPROVED, 'Services can only be enabled for approved merchants');
    }
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.merchant.updateMany({
        where: { id: merchantId, version: merchant.version },
        data: {
          ...(input.payin_enabled !== undefined ? { payinEnabled: input.payin_enabled } : {}),
          ...(input.payout_enabled !== undefined ? { payoutEnabled: input.payout_enabled } : {}),
          ...(input.risk_category ? { riskCategory: input.risk_category } : {}),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'The merchant changed concurrently; reload and retry');
      await this.audit.record(
        {
          action: 'merchant.settings.updated',
          resourceType: 'merchant',
          resourceId: merchantId,
          organizationId: merchantId,
          oldValue: { payin_enabled: merchant.payinEnabled, payout_enabled: merchant.payoutEnabled, risk_category: merchant.riskCategory },
          newValue: { payin_enabled: input.payin_enabled ?? merchant.payinEnabled, payout_enabled: input.payout_enabled ?? merchant.payoutEnabled, risk_category: input.risk_category ?? merchant.riskCategory },
          metadata: { reason: input.reason },
        },
        tx,
      );
      await this.outbox.add(tx, { eventType: 'merchant.settings_updated', aggregateType: 'merchant', aggregateId: merchantId, payload: { merchant_id: merchantId } });
    });
    return { updated: true };
  }

  private async notifyMerchant(merchantId: string, subject: string, text: string) {
    const recipients = await this.prisma.userRole.findMany({
      where: { organizationId: merchantId, role: { key: { in: ['MERCHANT_OWNER', 'MERCHANT_ADMIN'] } }, user: { status: { in: ['ACTIVE', 'INVITED'] } } },
      select: { user: { select: { email: true } } },
    });
    const profile = await this.prisma.merchantProfile.findUnique({ where: { merchantId }, select: { contactEmail: true } });
    const emails = new Set([...recipients.map((r) => r.user.email), ...(profile?.contactEmail ? [profile.contactEmail] : [])]);
    for (const to of emails) this.mail.sendInBackground({ to, subject, text });
  }
}
