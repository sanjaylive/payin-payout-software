import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { DbClient, PricingPlan, PricingPlanKind, PricingRule, PricingSubjectType, Prisma, PrismaClient, Scheme, SchemeRate } from '@pay2all/database';
import { computeFee, minorToMajorString, parseRateMicros, RATE_SCALE, schemeCharge, selectRule, selectSchemeRate, taxOn } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import type { assignPricingPlanSchema, createPricingPlanSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';

type PlanWithRules = PricingPlan & { rules: PricingRule[] };
type SchemeWithRates = Scheme & { rates: SchemeRate[] };

export interface PricingQuote {
  merchantFeeMinor: bigint;
  /** Scheme commission credited to the merchant (fee is then 0). */
  merchantCommissionMinor: bigint;
  taxMinor: bigint;
  taxRateMicros: bigint;
  wholesaleFeeMinor: bigint | null;
  providerCostMinor: bigint;
  resellerMarginMinor: bigint;
  platformMarginMinor: bigint;
  refundFee: boolean;
  /** Exact copies of plans/rules used — stored in the snapshot. */
  detail: Record<string, unknown>;
}

const ruleJson = (r: PricingRule | null) =>
  r && {
    id: r.id,
    method: r.method,
    provider_id: r.providerId,
    min_amount_minor: r.minAmountMinor?.toString() ?? null,
    max_amount_minor: r.maxAmountMinor?.toString() ?? null,
    charge_type: r.chargeType,
    rate_micros: r.rateMicros?.toString() ?? null,
    flat_minor: r.flatMinor?.toString() ?? null,
    min_fee_minor: r.minFeeMinor?.toString() ?? null,
    max_fee_minor: r.maxFeeMinor?.toString() ?? null,
  };

/**
 * Rate cards (provider cost → Pay2All wholesale → merchant price) and immutable per-transaction
 * snapshots. Historical fees are never recomputed: every transaction stores the exact rules used.
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private effective(at: Date): Prisma.PricingPlanWhereInput {
    return { status: 'ACTIVE', effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] };
  }

  /** Assigned plan for a subject at a time, else the owner's default plan of that kind. */
  private async planFor(kind: PricingPlanKind, subject: { type: PricingSubjectType; id: string } | null, defaultOwners: string[], at: Date): Promise<PlanWithRules | null> {
    if (subject) {
      const assignment = await this.prisma.pricingAssignment.findFirst({
        where: { subjectType: subject.type, subjectId: subject.id, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }], plan: { kind, ...this.effective(at) } },
        orderBy: { effectiveFrom: 'desc' },
        include: { plan: { include: { rules: true } } },
      });
      if (assignment) return assignment.plan;
    }
    for (const owner of defaultOwners) {
      const plan = await this.prisma.pricingPlan.findFirst({ where: { kind, ownerOrgId: owner, isDefault: true, ...this.effective(at) }, orderBy: { effectiveFrom: 'desc' }, include: { rules: true } });
      if (plan) return plan;
    }
    return null;
  }

  /**
   * Which pricing applies to a merchant, in order (docs/PRICING_SCHEMES.md §4):
   * assigned scheme → merchant rate-card assignment → its reseller's default rate card → default
   * scheme → platform default rate card.
   */
  async resolveMerchantPricing(merchantId: string, at = new Date()): Promise<{ source: 'ASSIGNED_SCHEME' | 'DEFAULT_SCHEME'; scheme: SchemeWithRates } | { source: 'RATE_CARD'; plan: PlanWithRules } | null> {
    const merchant = await this.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { resellerId: true, scheme: { include: { rates: true } } } });
    if (merchant.scheme?.status === 'ACTIVE') return { source: 'ASSIGNED_SCHEME', scheme: merchant.scheme };
    const assigned = await this.planFor('MERCHANT', { type: 'MERCHANT', id: merchantId }, merchant.resellerId ? [merchant.resellerId] : [], at);
    if (assigned) return { source: 'RATE_CARD', plan: assigned };
    const scheme = await this.prisma.scheme.findFirst({ where: { isDefault: true, status: 'ACTIVE' }, include: { rates: true } });
    if (scheme) return { source: 'DEFAULT_SCHEME', scheme };
    const platform = await this.prisma.organization.findFirstOrThrow({ where: { type: 'PLATFORM' }, select: { id: true } });
    const plan = await this.planFor('MERCHANT', null, [platform.id], at);
    return plan ? { source: 'RATE_CARD', plan } : null;
  }

  /** The active pricing provider (1 = Payout, 2 = Dynamic QR, …) that covers a method. */
  async pricingProviderFor(service: 'PAYIN' | 'PAYOUT', method: string) {
    return this.prisma.pricingProvider.findFirst({ where: { service, isActive: true, methods: { has: method } }, orderBy: { id: 'asc' } });
  }

  /** Fee or commission from a scheme; throws a clear error when the scheme does not cover it. */
  async schemeQuote(scheme: SchemeWithRates, service: 'PAYIN' | 'PAYOUT', method: string, amountMinor: bigint) {
    const disabled = service === 'PAYIN' ? ErrorCode.PAYIN_DISABLED : ErrorCode.PAYOUT_DISABLED;
    const provider = await this.pricingProviderFor(service, method);
    if (!provider) throw new AppError(disabled, `No pricing provider covers ${method}; add it in Settings → Pricing Providers`);
    const rate = selectSchemeRate(scheme.rates, provider.id, amountMinor);
    if (!rate) throw new AppError(disabled, `Pricing scheme "${scheme.name}" has no rate for ${provider.name} at ₹${minorToMajorString(amountMinor)}`);
    const { feeMinor, commissionMinor } = schemeCharge(rate, amountMinor);
    return { provider, rate, feeMinor, commissionMinor, taxMinor: taxOn(feeMinor, scheme.taxRateMicros) };
  }

  async quote(input: { merchantId: string; service: 'PAYIN' | 'PAYOUT'; method: string; providerId: string | null; amountMinor: bigint; at?: Date }): Promise<PricingQuote> {
    const at = input.at ?? new Date();
    const merchant = await this.prisma.merchant.findUniqueOrThrow({ where: { id: input.merchantId }, select: { resellerId: true } });
    const platform = await this.prisma.organization.findFirstOrThrow({ where: { type: 'PLATFORM' }, select: { id: true } });
    const ctx = { service: input.service, method: input.method, providerId: input.providerId, amountMinor: input.amountMinor };
    const costPlanFor = async () => {
      const costPlan = input.providerId ? await this.planFor('PROVIDER_COST', { type: 'PROVIDER', id: input.providerId }, [platform.id], at) : null;
      const costRule = costPlan ? selectRule(costPlan.rules, ctx) : null;
      return { costPlan, costRule, providerCost: costRule ? computeFee(costRule, input.amountMinor) : 0n };
    };

    const resolved = await this.resolveMerchantPricing(input.merchantId, at);
    if (resolved && resolved.source !== 'RATE_CARD') {
      // A platform scheme replaces the reseller layer: no wholesale, no reseller margin.
      const { scheme } = resolved;
      const q = await this.schemeQuote(scheme, input.service, input.method, input.amountMinor);
      const { costPlan, costRule, providerCost } = await costPlanFor();
      return {
        merchantFeeMinor: q.feeMinor,
        merchantCommissionMinor: q.commissionMinor,
        taxMinor: q.taxMinor,
        taxRateMicros: scheme.taxRateMicros,
        wholesaleFeeMinor: null,
        providerCostMinor: providerCost,
        resellerMarginMinor: 0n,
        platformMarginMinor: q.feeMinor - q.commissionMinor - providerCost,
        refundFee: false,
        detail: {
          at: at.toISOString(),
          context: { service: input.service, method: input.method, provider_id: input.providerId, amount_minor: input.amountMinor.toString() },
          scheme: {
            id: scheme.id,
            name: scheme.name,
            source: resolved.source,
            version: scheme.version,
            tax_rate_micros: scheme.taxRateMicros.toString(),
            pricing_provider: { id: q.provider.id, name: q.provider.name },
            rate: { id: q.rate.id, min_amount_minor: q.rate.minAmountMinor.toString(), max_amount_minor: q.rate.maxAmountMinor?.toString() ?? null, type: q.rate.valueType, value: q.rate.value.toString() },
          },
          provider_cost_plan: costPlan ? { id: costPlan.id, name: costPlan.name, rule: ruleJson(costRule) } : null,
        },
      };
    }

    const merchantPlan = resolved?.plan ?? null;
    const merchantRule = merchantPlan ? selectRule(merchantPlan.rules, ctx) : null;
    if (!merchantPlan || !merchantRule) {
      throw new AppError(input.service === 'PAYIN' ? ErrorCode.PAYIN_DISABLED : ErrorCode.PAYOUT_DISABLED, 'Pricing is not configured for this transaction type');
    }
    const wholesalePlan = merchant.resellerId ? await this.planFor('WHOLESALE', { type: 'RESELLER', id: merchant.resellerId }, [platform.id], at) : null;
    const wholesaleRule = wholesalePlan ? selectRule(wholesalePlan.rules, ctx) : null;
    const { costPlan, costRule, providerCost } = await costPlanFor();

    const merchantFee = computeFee(merchantRule, input.amountMinor);
    const tax = taxOn(merchantFee, merchantPlan.taxRateMicros);
    const wholesaleFee = merchant.resellerId ? (wholesaleRule ? computeFee(wholesaleRule, input.amountMinor) : merchantFee) : null;

    return {
      merchantFeeMinor: merchantFee,
      merchantCommissionMinor: 0n,
      taxMinor: tax,
      taxRateMicros: merchantPlan.taxRateMicros,
      wholesaleFeeMinor: wholesaleFee,
      providerCostMinor: providerCost,
      resellerMarginMinor: wholesaleFee === null ? 0n : merchantFee - wholesaleFee,
      platformMarginMinor: (wholesaleFee ?? merchantFee) - providerCost,
      refundFee: merchantPlan.refundFee,
      detail: {
        at: at.toISOString(),
        context: { service: input.service, method: input.method, provider_id: input.providerId, amount_minor: input.amountMinor.toString() },
        merchant_plan: { id: merchantPlan.id, name: merchantPlan.name, tax_rate_micros: merchantPlan.taxRateMicros.toString(), rule: ruleJson(merchantRule) },
        wholesale_plan: wholesalePlan ? { id: wholesalePlan.id, name: wholesalePlan.name, rule: ruleJson(wholesaleRule) } : null,
        provider_cost_plan: costPlan ? { id: costPlan.id, name: costPlan.name, rule: ruleJson(costRule) } : null,
      },
    };
  }

  /** Persist the immutable snapshot in the caller's transaction. */
  async snapshot(tx: DbClient, transactionType: 'PAYIN' | 'PAYOUT' | 'REFUND', transactionId: string, merchantId: string, q: PricingQuote): Promise<void> {
    await tx.transactionPricingSnapshot.create({
      data: {
        id: newId('pricingSnapshot'),
        transactionType,
        transactionId,
        merchantId,
        pricing: q.detail as Prisma.InputJsonValue,
        merchantFeeMinor: q.merchantFeeMinor,
        merchantCommissionMinor: q.merchantCommissionMinor,
        taxMinor: q.taxMinor,
        taxRateMicros: q.taxRateMicros,
        wholesaleFeeMinor: q.wholesaleFeeMinor,
        providerCostMinor: q.providerCostMinor,
        resellerMarginMinor: q.resellerMarginMinor,
        platformMarginMinor: q.platformMarginMinor,
        refundFee: q.refundFee,
      },
    });
  }

  // ---- Administration --------------------------------------------------------------------------

  private presentPlan(p: PlanWithRules) {
    const pct = (micros: bigint | null) => (micros === null ? null : `${micros / RATE_SCALE}.${String(micros % RATE_SCALE).padStart(6, '0').replace(/0+$/, '') || '0'}`);
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      status: p.status,
      owner_org_id: p.ownerOrgId,
      is_default: p.isDefault,
      tax_rate: pct(p.taxRateMicros),
      refund_fee: p.refundFee,
      effective_from: p.effectiveFrom,
      effective_to: p.effectiveTo,
      rules: p.rules.map((r) => ({
        id: r.id,
        service: r.service,
        method: r.method,
        provider_id: r.providerId,
        min_amount: r.minAmountMinor === null ? null : minorToMajorString(r.minAmountMinor),
        max_amount: r.maxAmountMinor === null ? null : minorToMajorString(r.maxAmountMinor),
        charge_type: r.chargeType,
        rate: pct(r.rateMicros),
        flat_fee: r.flatMinor === null ? null : minorToMajorString(r.flatMinor),
        min_fee: r.minFeeMinor === null ? null : minorToMajorString(r.minFeeMinor),
        max_fee: r.maxFeeMinor === null ? null : minorToMajorString(r.maxFeeMinor),
      })),
      created_at: p.createdAt,
    };
  }

  /** Platform: every plan. Reseller: its own merchant rate cards plus the wholesale plan it pays (read-only). */
  async listPlans(actor: Actor) {
    if (actor.organizationType === 'PLATFORM') {
      const plans = await this.prisma.pricingPlan.findMany({ include: { rules: true }, orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }] });
      return plans.map((p) => this.presentPlan(p));
    }
    const own = await this.prisma.pricingPlan.findMany({ where: { ownerOrgId: actor.organizationId }, include: { rules: true }, orderBy: { createdAt: 'desc' } });
    const wholesale = actor.organizationType === 'RESELLER' ? await this.wholesaleFor(actor.organizationId) : null;
    return [...(wholesale ? [this.presentPlan(wholesale)] : []), ...own.map((p) => this.presentPlan(p))];
  }

  private async wholesaleFor(resellerId: string, at = new Date()) {
    const platform = await this.prisma.organization.findFirstOrThrow({ where: { type: 'PLATFORM' }, select: { id: true } });
    return this.planFor('WHOLESALE', { type: 'RESELLER', id: resellerId }, [platform.id], at);
  }

  /**
   * A reseller's merchant price may never be below what the reseller pays us: checked at
   * representative amounts per service for the method/mode the rules target.
   */
  private async assertNotBelowWholesale(resellerId: string, rules: z.output<typeof createPricingPlanSchema>['rules']) {
    const wholesale = await this.wholesaleFor(resellerId);
    if (!wholesale) throw new AppError(ErrorCode.INVALID_REQUEST, 'No wholesale price is set for your account yet; contact Pay2All');
    const asRules = rules.map((r, i) => ({ id: `new_${i}`, service: r.service, method: r.method, providerId: r.provider_id, minAmountMinor: r.min_amount, maxAmountMinor: r.max_amount, chargeType: r.charge_type, rateMicros: r.rate === null ? null : parseRateMicros(r.rate), flatMinor: r.flat_fee, minFeeMinor: r.min_fee, maxFeeMinor: r.max_fee }));
    const samples = [10_000n, 100_000n, 1_000_000n, 10_000_000n, 50_000_000n];
    for (const service of [...new Set(rules.map((r) => r.service))]) {
      const methods = [...new Set(rules.filter((r) => r.service === service).map((r) => r.method ?? (service === 'PAYIN' ? 'UPI_QR' : 'IMPS')))];
      for (const method of methods) {
        for (const amountMinor of samples) {
          const ctx = { service, method, providerId: null, amountMinor };
          const mine = selectRule(asRules, ctx);
          const theirs = selectRule(wholesale.rules, ctx);
          if (!mine || !theirs) continue;
          const fee = computeFee(mine, amountMinor);
          const floor = computeFee(theirs, amountMinor);
          if (fee < floor) {
            throw new AppError(ErrorCode.INVALID_REQUEST, `${service} ${method} at ₹${minorToMajorString(amountMinor)}: fee ₹${minorToMajorString(fee)} is below your wholesale price ₹${minorToMajorString(floor)}`);
          }
        }
      }
    }
  }

  /**
   * Plans are versioned by replacement, not edited: a pricing change is a new plan (effective from
   * a date) so every historical snapshot keeps pointing at what was actually charged.
   */
  async createPlan(actor: Actor, input: z.output<typeof createPricingPlanSchema>) {
    if (actor.organizationType === 'RESELLER') {
      // Reseller rate cards: merchant pricing for its own merchants, never below its wholesale.
      if (input.kind !== 'MERCHANT') throw new AppError(ErrorCode.FORBIDDEN, 'Resellers can create merchant rate cards only');
      await this.assertNotBelowWholesale(actor.organizationId, input.rules);
    } else if (actor.organizationType !== 'PLATFORM') {
      throw new AppError(ErrorCode.FORBIDDEN);
    }
    const plan = await this.prisma.$transaction(async (tx) => {
      if (input.is_default) {
        await tx.pricingPlan.updateMany({ where: { kind: input.kind, ownerOrgId: actor.organizationId, isDefault: true }, data: { isDefault: false } });
      }
      const created = await tx.pricingPlan.create({
        data: {
          id: newId('pricingPlan'),
          name: input.name,
          kind: input.kind,
          ownerOrgId: actor.organizationId,
          isDefault: input.is_default,
          taxRateMicros: parseRateMicros(input.tax_rate),
          refundFee: input.refund_fee,
          effectiveFrom: input.effective_from ? new Date(input.effective_from) : new Date(),
          effectiveTo: input.effective_to ? new Date(input.effective_to) : null,
          createdById: actor.userId,
          rules: {
            create: input.rules.map((r) => ({
              id: newId('pricingRule'),
              service: r.service,
              method: r.method,
              providerId: r.provider_id,
              minAmountMinor: r.min_amount,
              maxAmountMinor: r.max_amount,
              chargeType: r.charge_type,
              rateMicros: r.rate === null ? null : parseRateMicros(r.rate),
              flatMinor: r.flat_fee,
              minFeeMinor: r.min_fee,
              maxFeeMinor: r.max_fee,
            })),
          },
        },
        include: { rules: true },
      });
      await this.audit.record({ action: 'pricing.plan.created', resourceType: 'pricing_plan', resourceId: created.id, organizationId: actor.organizationType === 'PLATFORM' ? null : actor.organizationId, newValue: this.presentPlan(created) }, tx);
      return created;
    });
    return this.presentPlan(plan);
  }

  async archivePlan(actor: Actor, id: string) {
    const plan = await this.prisma.pricingPlan.findUnique({ where: { id } });
    // Only the owner (or the platform) can archive — a reseller must never be able to switch off
    // the platform's default pricing.
    if (!plan || (actor.organizationType !== 'PLATFORM' && plan.ownerOrgId !== actor.organizationId)) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.pricingPlan.update({ where: { id }, data: { status: 'ARCHIVED', isDefault: false, effectiveTo: new Date(), version: { increment: 1 } } });
      await this.audit.record({ action: 'pricing.plan.archived', resourceType: 'pricing_plan', resourceId: id, organizationId: null }, tx);
    });
    return { archived: true };
  }

  async assign(actor: Actor, input: z.output<typeof assignPricingPlanSchema>) {
    const plan = await this.prisma.pricingPlan.findUnique({ where: { id: input.plan_id } });
    if (!plan || plan.status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_REQUEST, 'Plan not found or archived');
    if (actor.organizationType !== 'PLATFORM') {
      // Resellers assign their own merchant rate cards to their own merchants only.
      if (actor.organizationType !== 'RESELLER' || plan.ownerOrgId !== actor.organizationId || plan.kind !== 'MERCHANT') throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
      const owned = input.subject_type === 'MERCHANT' && (await this.prisma.merchant.count({ where: { id: input.subject_id, resellerId: actor.organizationId } }));
      if (!owned) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    }
    const expected: Record<PricingPlanKind, PricingSubjectType> = { MERCHANT: 'MERCHANT', WHOLESALE: 'RESELLER', PROVIDER_COST: 'PROVIDER' };
    if (expected[plan.kind] !== input.subject_type) throw new AppError(ErrorCode.INVALID_REQUEST, `${plan.kind} plans are assigned to ${expected[plan.kind].toLowerCase()}s`);
    const exists =
      input.subject_type === 'PROVIDER'
        ? await this.prisma.provider.count({ where: { id: input.subject_id } })
        : await this.prisma.organization.count({ where: { id: input.subject_id, type: input.subject_type } });
    if (!exists) throw new AppError(ErrorCode.INVALID_REQUEST, 'Subject not found');
    const from = input.effective_from ? new Date(input.effective_from) : new Date();
    await this.prisma.$transaction(async (tx) => {
      // Close the current assignment so history stays contiguous.
      await tx.pricingAssignment.updateMany({ where: { subjectType: input.subject_type, subjectId: input.subject_id, effectiveTo: null, plan: { kind: plan.kind } }, data: { effectiveTo: from } });
      await tx.pricingAssignment.create({ data: { id: newId('pricingAssignment'), planId: plan.id, subjectType: input.subject_type, subjectId: input.subject_id, effectiveFrom: from, createdById: actor.userId } });
      await this.audit.record({ action: 'pricing.assigned', resourceType: input.subject_type.toLowerCase(), resourceId: input.subject_id, organizationId: input.subject_type === 'PROVIDER' ? null : input.subject_id, newValue: { plan_id: plan.id, plan_name: plan.name, effective_from: from } }, tx);
    });
    return { assigned: true, plan_id: plan.id, subject_id: input.subject_id, effective_from: from };
  }

  presentQuote(q: PricingQuote) {
    return {
      merchant_fee: minorToMajorString(q.merchantFeeMinor),
      merchant_commission: minorToMajorString(q.merchantCommissionMinor),
      tax: minorToMajorString(q.taxMinor),
      wholesale_fee: q.wholesaleFeeMinor === null ? null : minorToMajorString(q.wholesaleFeeMinor),
      provider_cost: minorToMajorString(q.providerCostMinor),
      reseller_margin: minorToMajorString(q.resellerMarginMinor),
      platform_margin: minorToMajorString(q.platformMarginMinor),
      detail: q.detail,
    };
  }
}
