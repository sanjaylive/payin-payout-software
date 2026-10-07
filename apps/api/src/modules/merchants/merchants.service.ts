import { Inject, Injectable } from '@nestjs/common';
import { generateToken, newId } from '@pay2all/auth';
import { type DbClient, Prisma, type PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { createMerchantSchema, listMerchantsQuerySchema, merchantProfileSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { OutboxService } from '../../infra/outbox.service';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { type ApplicationSnapshot, evaluateRequirements } from './compliance-requirements';
import { MerchantAccessService } from './merchant-access.service';
import {
  MERCHANT_LIST_SELECT,
  presentBankAccount,
  presentDocument,
  presentMerchantSummary,
  presentPerson,
  presentProfile,
  presentReview,
} from './merchant.presenter';

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'merchant';
  return `${base}-${generateToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 80);
}

export interface CreateMerchantInput {
  displayName: string;
  resellerId: string | null;
  /** Organization parent when it isn't the reseller (an API partner). Defaults to reseller, then platform. */
  parentId?: string | null;
  source?: string | null;
  assignedSalesUserId?: string | null;
}

@Injectable()
export class MerchantsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
    private readonly access: MerchantAccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Where a new merchant sits: resellers and API partners always create under themselves; platform
   * staff may choose a reseller (commission relationship) or an API partner (integration relationship).
   */
  async resolveParent(actor: Actor, body: { reseller_id?: string; partner_id?: string }): Promise<{ resellerId: string | null; parentId: string | null }> {
    if (actor.organizationType === 'API_PARTNER') {
      if (body.reseller_id || (body.partner_id && body.partner_id !== actor.organizationId)) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found');
      return { resellerId: null, parentId: actor.organizationId };
    }
    if (body.partner_id) {
      if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
      const partner = await this.scope.requireOrganization(actor, body.partner_id);
      if (partner.type !== 'API_PARTNER') throw new AppError(ErrorCode.INVALID_REQUEST, 'partner_id must be an API partner organization');
      if (partner.status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_REQUEST, 'API partner is not active');
      return { resellerId: null, parentId: partner.id };
    }
    const resellerId = await this.resolveReseller(actor, body.reseller_id);
    return { resellerId, parentId: resellerId };
  }

  /** Resolve the parent reseller for a new merchant: resellers always create under themselves. */
  async resolveReseller(actor: Actor, requested?: string): Promise<string | null> {
    if (actor.organizationType === 'RESELLER') {
      if (requested && requested !== actor.organizationId) throw new AppError(ErrorCode.NOT_FOUND, 'Reseller not found');
      return actor.organizationId;
    }
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    if (!requested) return null;
    const reseller = await this.scope.requireOrganization(actor, requested);
    if (reseller.type !== 'RESELLER') throw new AppError(ErrorCode.INVALID_REQUEST, 'reseller_id must be a reseller organization');
    if (reseller.status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_REQUEST, 'Reseller is not active');
    return reseller.id;
  }

  /** Create organization + merchant aggregate atomically (also used by lead conversion). */
  async createInTx(tx: DbClient, actor: Actor, input: CreateMerchantInput) {
    const platform = await tx.organization.findFirstOrThrow({ where: { type: 'PLATFORM' }, select: { id: true } });
    const id = newId('organization');
    await tx.organization.create({
      data: {
        id,
        type: 'MERCHANT',
        name: input.displayName,
        slug: slugify(input.displayName),
        parentId: input.parentId ?? input.resellerId ?? platform.id,
        source: input.source ?? null,
        assignedSalesUserId: input.assignedSalesUserId ?? null,
      },
    });
    await tx.merchant.create({ data: { id, resellerId: input.resellerId } });
    await tx.merchantProfile.create({ data: { merchantId: id, displayName: input.displayName, updatedById: actor.userId } });
    await tx.merchantKyc.create({ data: { merchantId: id } });
    await tx.complianceReview.create({
      data: { id: newId('complianceReview'), merchantId: id, action: 'CREATED', toStatus: 'DRAFT', reviewedById: actor.userId, reason: 'Merchant account created' },
    });
    await this.audit.record(
      { action: 'merchant.created', resourceType: 'merchant', resourceId: id, organizationId: id, newValue: { display_name: input.displayName, reseller_id: input.resellerId, source: input.source } },
      tx,
    );
    await this.outbox.add(tx, { eventType: 'merchant.created', aggregateType: 'merchant', aggregateId: id, payload: { merchant_id: id, reseller_id: input.resellerId } });
    return id;
  }

  async create(actor: Actor, body: z.output<typeof createMerchantSchema>) {
    const { resellerId, parentId } = await this.resolveParent(actor, body);
    const id = await this.prisma.$transaction((tx) =>
      this.createInTx(tx, actor, { displayName: body.display_name, resellerId, parentId, source: body.source ?? null }),
    );
    return this.get(actor, id);
  }

  async list(actor: Actor, query: z.output<typeof listMerchantsQuerySchema>) {
    const rows = await this.prisma.merchant.findMany({
      where: {
        AND: [
          this.access.where(actor),
          query.status ? { status: { in: query.status } } : {},
          query.reseller_id ? { resellerId: query.reseller_id } : {},
          query.search
            ? {
                OR: [
                  { id: query.search },
                  { organization: { name: { contains: query.search, mode: 'insensitive' } } },
                  { profile: { legalName: { contains: query.search, mode: 'insensitive' } } },
                  { profile: { pan: query.search.toUpperCase() } },
                  { profile: { gstin: query.search.toUpperCase() } },
                ],
              }
            : {},
          keysetAfter(decodeCursor(query.cursor)),
        ],
      },
      select: MERCHANT_LIST_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, presentMerchantSummary);
  }

  /** Full onboarding application: profile, people, bank accounts, documents, screening, checklist. */
  async get(actor: Actor, merchantId: string) {
    await this.access.require(actor, merchantId);
    const m = await this.prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: {
        ...MERCHANT_LIST_SELECT,
        version: true,
        profile: true,
        kyc: true,
        persons: { orderBy: { createdAt: 'asc' } },
        bankAccounts: { where: { isActive: true }, orderBy: { createdAt: 'asc' } },
        documents: { orderBy: { createdAt: 'desc' } },
        reviews: { orderBy: { reviewedAt: 'desc' }, take: 50 },
      },
    });

    // Risk signal: settlement accounts also registered to other merchants.
    const shared = await this.prisma.merchantBankAccount.findMany({
      where: { accountNumberHash: { in: m.bankAccounts.map((b) => b.accountNumberHash) }, merchantId: { not: merchantId }, isActive: true },
      select: { accountNumberHash: true },
    });
    const sharedHashes = new Set(shared.map((s) => s.accountNumberHash));

    const snapshot: ApplicationSnapshot = {
      status: m.status,
      profile: m.profile,
      persons: m.persons,
      bankAccounts: m.bankAccounts,
      documents: m.documents,
      kyc: m.kyc,
    };
    const requirements = evaluateRequirements(snapshot);
    const isPlatform = actor.organizationType === 'PLATFORM';

    return {
      ...presentMerchantSummary(m),
      profile: presentProfile(m.profile),
      persons: m.persons.map(presentPerson),
      bank_accounts: m.bankAccounts.map((b) => presentBankAccount(b, isPlatform && sharedHashes.has(b.accountNumberHash))),
      documents: m.documents.map(presentDocument),
      screening: m.kyc
        ? {
            sanctions_status: m.kyc.sanctionsStatus,
            pep_status: m.kyc.pepStatus,
            adverse_media_status: m.kyc.adverseMediaStatus,
            screened_at: m.kyc.screenedAt,
            // Internal risk notes are visible to platform staff only.
            ...(isPlatform ? { risk_notes: m.kyc.riskNotes } : {}),
          }
        : null,
      requirements: requirements.map((r) => ({ key: r.key, label: r.label, satisfied: r.satisfied, stage: r.stage })),
      can_submit: ['DRAFT', 'MORE_INFORMATION_REQUIRED'].includes(m.status) && requirements.every((r) => r.stage !== 'SUBMISSION' || r.satisfied),
      reviews: m.reviews.map(presentReview),
      version: m.version,
    };
  }

  async updateProfile(actor: Actor, merchantId: string, input: z.output<typeof merchantProfileSchema>) {
    await this.access.requireEditable(actor, merchantId);
    const data: Prisma.MerchantProfileUncheckedUpdateInput = { updatedById: actor.userId };
    const map: [keyof typeof input, keyof Prisma.MerchantProfileUncheckedUpdateInput][] = [
      ['legal_name', 'legalName'], ['display_name', 'displayName'], ['entity_type', 'entityType'], ['pan', 'pan'],
      ['gstin', 'gstin'], ['cin', 'cin'], ['llpin', 'llpin'], ['website', 'website'], ['app_url', 'appUrl'],
      ['business_category', 'businessCategory'], ['mcc', 'mcc'], ['business_description', 'businessDescription'],
      ['expected_monthly_volume', 'expectedMonthlyVolumeMinor'], ['average_ticket_size', 'averageTicketMinor'],
      ['maximum_ticket_size', 'maximumTicketMinor'], ['payin_required', 'payinRequired'], ['payout_required', 'payoutRequired'],
      ['settlement_preference', 'settlementPreference'], ['contact_name', 'contactName'], ['contact_email', 'contactEmail'],
      ['contact_mobile', 'contactMobile'],
    ];
    for (const [from, to] of map) {
      if (input[from] !== undefined) (data as Record<string, unknown>)[to] = input[from];
    }
    if (input.registered_address !== undefined) data.registeredAddress = input.registered_address;
    if (input.operational_address !== undefined) {
      data.operationalAddress = input.operational_address ?? Prisma.DbNull;
    }

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.merchantProfile.findUniqueOrThrow({ where: { merchantId } });
      const after = await tx.merchantProfile.update({ where: { merchantId }, data });
      if (input.display_name) await tx.organization.update({ where: { id: merchantId }, data: { name: input.display_name } });
      await this.audit.record(
        { action: 'merchant.profile.updated', resourceType: 'merchant', resourceId: merchantId, organizationId: merchantId, oldValue: presentProfile(before), newValue: presentProfile(after), metadata: { fields: Object.keys(input) } },
        tx,
      );
    });
    return this.get(actor, merchantId);
  }
}
