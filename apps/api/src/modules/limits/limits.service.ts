import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { LimitLevel, PrismaClient, ServiceType } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import type { upsertApprovalPolicySchema, upsertLimitSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { MerchantAccessService } from '../merchants/merchant-access.service';
import {
  type ApprovalPolicyShape,
  approvalsRequired,
  isLooserPolicy,
  LIMIT_FIELDS,
  type LimitField,
  type LimitLayer,
  loosenedFields,
  parseTiers,
  type ResolvedField,
  resolveLimits,
  serializeTiers,
} from './limit-resolution';

const FIELD_API_NAME: Record<LimitField, string> = {
  perTxnMinMinor: 'per_transaction_min',
  perTxnMaxMinor: 'per_transaction_max',
  dailyAmountMinor: 'daily_amount',
  dailyCount: 'daily_count',
  monthlyAmountMinor: 'monthly_amount',
  monthlyCount: 'monthly_count',
};
const isAmount = (f: LimitField) => f.endsWith('Minor');
const SERVICES: ServiceType[] = ['PAYIN', 'PAYOUT'];

function presentValue(field: LimitField, value: bigint | number | null) {
  if (value === null) return null;
  return isAmount(field) ? minorToMajorString(BigInt(value)) : Number(value);
}

function presentResolved(resolved: Record<LimitField, ResolvedField>) {
  return Object.fromEntries(
    LIMIT_FIELDS.map((f) => [FIELD_API_NAME[f], { value: presentValue(f, resolved[f].value), source: resolved[f].source }]),
  );
}

interface Subject {
  level: LimitLevel;
  subjectId: string | null;
}

@Injectable()
export class LimitsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
    private readonly merchants: MerchantAccessService,
    private readonly audit: AuditService,
  ) {}

  /** Validate that the actor may configure this level/subject. */
  private async authorizeSubject(actor: Actor, level: LimitLevel, subjectId?: string): Promise<Subject> {
    if (level === 'SYSTEM') {
      if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN, 'Only platform staff can change system settings');
      return { level, subjectId: null };
    }
    const org = await this.scope.requireOrganization(actor, subjectId!);
    if (org.type !== level) throw new AppError(ErrorCode.INVALID_REQUEST, `subject_id must be a ${level.toLowerCase()} organization`);
    return { level, subjectId: org.id };
  }

  /** Layers above a subject, most specific first (used for ceilings and effective values). */
  private async parentChain(subject: Subject): Promise<Subject[]> {
    if (subject.level === 'SYSTEM') return [];
    if (subject.level === 'RESELLER') return [{ level: 'SYSTEM', subjectId: null }];
    const merchant = await this.prisma.merchant.findUniqueOrThrow({ where: { id: subject.subjectId! }, select: { resellerId: true } });
    return [...(merchant.resellerId ? [{ level: 'RESELLER' as const, subjectId: merchant.resellerId }] : []), { level: 'SYSTEM', subjectId: null }];
  }

  private async limitLayers(chain: Subject[], service: ServiceType): Promise<LimitLayer[]> {
    const rows = await Promise.all(
      chain.map((s) => this.prisma.limitConfig.findFirst({ where: { level: s.level, subjectId: s.subjectId, service } })),
    );
    return chain.map((s, i) => ({ level: s.level, values: rows[i] ?? {} }));
  }

  /** Effective limits for a merchant (consumed by Payin/Payout in later phases). */
  async resolveForMerchant(merchantId: string, service: ServiceType) {
    const chain = [{ level: 'MERCHANT' as const, subjectId: merchantId }, ...(await this.parentChain({ level: 'MERCHANT', subjectId: merchantId }))];
    return resolveLimits(await this.limitLayers(chain, service));
  }

  async effective(actor: Actor, merchantId: string) {
    await this.merchants.require(actor, merchantId);
    const out: Record<string, unknown> = {};
    for (const service of SERVICES) out[service.toLowerCase()] = presentResolved(await this.resolveForMerchant(merchantId, service));
    return out;
  }

  async get(actor: Actor, level: LimitLevel, subjectId?: string) {
    const subject = await this.authorizeSubject(actor, level, subjectId).catch((err: unknown) => {
      // Reading SYSTEM limits is fine for anyone with limit.read.
      if (level === 'SYSTEM') return { level, subjectId: null };
      throw err;
    });
    const rows = await this.prisma.limitConfig.findMany({ where: { level: subject.level, subjectId: subject.subjectId } });
    return SERVICES.map((service) => {
      const row = rows.find((r) => r.service === service);
      return {
        service,
        level,
        subject_id: subject.subjectId,
        ...Object.fromEntries(LIMIT_FIELDS.map((f) => [FIELD_API_NAME[f], presentValue(f, row?.[f] ?? null)])),
        updated_at: row?.updatedAt ?? null,
        version: row?.version ?? 0,
      };
    });
  }

  async upsert(actor: Actor, input: z.output<typeof upsertLimitSchema>) {
    const subject = await this.authorizeSubject(actor, input.level, input.subject_id);
    const proposed: Record<string, bigint | number | null | undefined> = {
      perTxnMinMinor: input.per_transaction_min,
      perTxnMaxMinor: input.per_transaction_max,
      dailyAmountMinor: input.daily_amount,
      dailyCount: input.daily_count,
      monthlyAmountMinor: input.monthly_amount,
      monthlyCount: input.monthly_count,
    };
    const changes = Object.fromEntries(Object.entries(proposed).filter(([, v]) => v !== undefined));

    if (actor.organizationType !== 'PLATFORM') {
      const parent = resolveLimits(await this.limitLayers(await this.parentChain(subject), input.service));
      const bad = loosenedFields(changes, parent);
      if (bad.length) {
        throw new AppError(ErrorCode.LIMIT_EXCEEDED, 'Limits cannot be looser than the parent level', bad.map((f) => ({ path: FIELD_API_NAME[f], message: 'Exceeds the limit set above your level' })));
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.limitConfig.findFirst({ where: { level: subject.level, subjectId: subject.subjectId, service: input.service } });
      const merged = { ...(existing ?? {}), ...changes } as Record<LimitField, bigint | number | null | undefined>;
      const min = merged.perTxnMinMinor;
      const max = merged.perTxnMaxMinor;
      if (min != null && max != null && BigInt(min) > BigInt(max)) {
        throw new AppError(ErrorCode.INVALID_REQUEST, 'Per-transaction minimum cannot exceed the maximum');
      }
      if (existing) {
        const updated = await tx.limitConfig.updateMany({
          where: { id: existing.id, version: existing.version },
          data: { ...changes, updatedById: actor.userId, version: { increment: 1 } },
        });
        if (updated.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Limits changed concurrently; reload and retry');
      } else {
        await tx.limitConfig.create({ data: { id: newId('limitConfig'), level: subject.level, subjectId: subject.subjectId, service: input.service, ...changes, updatedById: actor.userId } });
      }
      const snapshot = (vals: Record<string, unknown> | null) =>
        vals ? Object.fromEntries(LIMIT_FIELDS.map((f) => [FIELD_API_NAME[f], presentValue(f, (vals[f] as bigint | number | null | undefined) ?? null)])) : null;
      await this.audit.record(
        { action: 'limits.updated', resourceType: 'limit_config', resourceId: `${subject.level}:${subject.subjectId ?? 'system'}:${input.service}`, organizationId: subject.subjectId, oldValue: snapshot(existing), newValue: snapshot(merged), metadata: { reason: input.reason } },
        tx,
      );
    });
    return this.get(actor, input.level, input.subject_id);
  }

  // ---- Approval policies -------------------------------------------------------------------------

  private async policyFor(subject: Subject): Promise<ApprovalPolicyShape | null> {
    const row = await this.prisma.approvalPolicy.findFirst({ where: { level: subject.level, subjectId: subject.subjectId, service: 'PAYOUT' } });
    return row ? { makerCheckerEnabled: row.makerCheckerEnabled, tiers: parseTiers(row.tiers) } : null;
  }

  private async effectivePolicy(chain: Subject[]): Promise<{ policy: ApprovalPolicyShape; source: LimitLevel } | null> {
    for (const s of chain) {
      const p = await this.policyFor(s);
      if (p) return { policy: p, source: s.level };
    }
    return null;
  }

  /** Used by Payout (Phase 6) to decide how many checkers a payout needs. */
  async approvalsRequiredFor(merchantId: string, amountMinor: bigint): Promise<number> {
    const subject: Subject = { level: 'MERCHANT', subjectId: merchantId };
    const effective = await this.effectivePolicy([subject, ...(await this.parentChain(subject))]);
    return effective ? approvalsRequired(effective.policy, amountMinor) : 0;
  }

  async effectivePolicyForMerchant(actor: Actor, merchantId: string) {
    await this.merchants.require(actor, merchantId);
    const subject: Subject = { level: 'MERCHANT', subjectId: merchantId };
    const effective = await this.effectivePolicy([subject, ...(await this.parentChain(subject))]);
    return effective
      ? { source: effective.source, maker_checker_enabled: effective.policy.makerCheckerEnabled, tiers: serializeTiers(effective.policy.tiers) }
      : null;
  }

  async upsertPolicy(actor: Actor, input: z.output<typeof upsertApprovalPolicySchema>) {
    let subject: Subject;
    if (input.level === 'MERCHANT' && actor.organizationType === 'MERCHANT') {
      // Merchants configure their own maker-checker tiers.
      if (input.subject_id !== actor.organizationId) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
      subject = { level: 'MERCHANT', subjectId: actor.organizationId };
    } else {
      subject = await this.authorizeSubject(actor, input.level, input.subject_id);
    }
    const proposed: ApprovalPolicyShape = {
      makerCheckerEnabled: input.maker_checker_enabled,
      tiers: input.tiers.map((t) => ({ upToMinor: t.up_to, approvalsRequired: t.approvals_required })),
    };
    if (actor.organizationType !== 'PLATFORM') {
      const parent = await this.effectivePolicy(await this.parentChain(subject));
      if (parent && isLooserPolicy(proposed, parent.policy)) {
        throw new AppError(ErrorCode.FORBIDDEN, `Approval rules cannot be looser than the ${parent.source.toLowerCase()} policy`);
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.approvalPolicy.findFirst({ where: { level: subject.level, subjectId: subject.subjectId, service: 'PAYOUT' } });
      const data = { makerCheckerEnabled: proposed.makerCheckerEnabled, tiers: serializeTiers(proposed.tiers), updatedById: actor.userId };
      if (existing) {
        const updated = await tx.approvalPolicy.updateMany({ where: { id: existing.id, version: existing.version }, data: { ...data, version: { increment: 1 } } });
        if (updated.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Policy changed concurrently; reload and retry');
      } else {
        await tx.approvalPolicy.create({ data: { id: newId('approvalPolicy'), level: subject.level, subjectId: subject.subjectId, service: 'PAYOUT', ...data } });
      }
      await this.audit.record(
        {
          action: 'approval_policy.updated',
          resourceType: 'approval_policy',
          resourceId: `${subject.level}:${subject.subjectId ?? 'system'}:PAYOUT`,
          organizationId: subject.subjectId,
          oldValue: existing ? { maker_checker_enabled: existing.makerCheckerEnabled, tiers: existing.tiers } : null,
          newValue: data,
          metadata: { reason: input.reason },
        },
        tx,
      );
    });
    return { level: subject.level, subject_id: subject.subjectId, maker_checker_enabled: proposed.makerCheckerEnabled, tiers: serializeTiers(proposed.tiers) };
  }

  async getPolicy(actor: Actor, level: LimitLevel, subjectId?: string) {
    const subject: Subject =
      level === 'SYSTEM'
        ? { level, subjectId: null }
        : level === 'MERCHANT' && actor.organizationType === 'MERCHANT' && subjectId === actor.organizationId
          ? { level, subjectId }
          : await this.authorizeSubject(actor, level, subjectId);
    const p = await this.policyFor(subject);
    return p ? { level, subject_id: subject.subjectId, maker_checker_enabled: p.makerCheckerEnabled, tiers: serializeTiers(p.tiers) } : null;
  }
}
