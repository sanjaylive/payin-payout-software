import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { isUniqueViolation, type PricingProvider, type Prisma, type PrismaClient, type Scheme, type SchemeRate } from '@pay2all/database';
import { findSlabOverlap, minorToMajorString, parseRateMicros, RATE_SCALE } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import type { assignSchemeSchema, pricingProviderSchema, saveSchemeSchema, schemeMerchantsQuerySchema, schemePreviewSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { PricingService } from '../pricing/pricing.service';

type ProviderInput = z.output<typeof pricingProviderSchema>;
type SchemeInput = z.output<typeof saveSchemeSchema>;
type SchemeWithRates = Scheme & { rates: (SchemeRate & { provider: PricingProvider })[] };

function platformOnly(actor: Actor) {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
}

/** Rate micros → "0.25" (no trailing zeros). */
function percent(micros: bigint): string {
  const whole = micros / RATE_SCALE;
  const frac = String(micros % RATE_SCALE).padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Stored signed value → the signed string the admin typed ("-5.00", "0.25"). */
export function presentValue(type: 'FLAT' | 'PERCENT', value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return sign + (type === 'FLAT' ? minorToMajorString(abs) : percent(abs));
}

function parseValue(type: 'FLAT' | 'PERCENT', input: string): bigint {
  const negative = input.startsWith('-');
  const abs = input.replace('-', '');
  const [whole = '0', frac = ''] = abs.split('.');
  const magnitude = type === 'FLAT' ? BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0') || '0') : parseRateMicros(abs);
  return negative ? -magnitude : magnitude;
}

/**
 * Pricing providers (numbered pricing lines) and merchant schemes (docs/PRICING_SCHEMES.md).
 * Fees already charged never change: every transaction keeps a snapshot of the exact rate used.
 */
@Injectable()
export class SchemesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
  ) {}

  // ---- Pricing providers ------------------------------------------------------------------------

  private presentProvider(p: PricingProvider, usage?: { schemes: number }) {
    return { id: p.id, name: p.name, service: p.service, methods: p.methods, description: p.description, is_active: p.isActive, version: p.version, used_by_schemes: usage?.schemes ?? 0, updated_at: p.updatedAt };
  }

  async listProviders(actor: Actor) {
    platformOnly(actor);
    const [providers, usage] = await Promise.all([
      this.prisma.pricingProvider.findMany({ orderBy: { id: 'asc' } }),
      this.prisma.$queryRaw<{ provider_id: number; schemes: bigint }[]>`
        SELECT r.provider_id, COUNT(DISTINCT r.scheme_id)::bigint AS schemes
          FROM scheme_rates r JOIN schemes s ON s.id = r.scheme_id
         WHERE s.status = 'ACTIVE' GROUP BY r.provider_id`,
    ]);
    const used = new Map(usage.map((u) => [u.provider_id, Number(u.schemes)]));
    return providers.map((p) => this.presentProvider(p, { schemes: used.get(p.id) ?? 0 }));
  }

  /** A payin method / payout mode is priced by exactly one active provider. */
  private async assertMethodsFree(tx: Prisma.TransactionClient, input: ProviderInput, selfId: number | null) {
    if (!input.is_active) return;
    const others = await tx.pricingProvider.findMany({ where: { service: input.service, isActive: true, methods: { hasSome: input.methods }, ...(selfId ? { id: { not: selfId } } : {}) } });
    if (others.length) {
      const taken = others.flatMap((o) => o.methods.filter((m) => input.methods.includes(m)).map((m) => `${m} (provider ${o.id}, ${o.name})`));
      throw new AppError(ErrorCode.CONFLICT, `Already priced by another provider: ${taken.join(', ')}`, [{ path: 'methods', message: 'Remove these methods from the other provider first' }]);
    }
  }

  async createProvider(actor: Actor, input: ProviderInput) {
    platformOnly(actor);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.assertMethodsFree(tx, input, null);
        const p = await tx.pricingProvider.create({ data: { name: input.name, service: input.service, methods: input.methods, description: input.description, isActive: input.is_active } });
        await this.audit.record({ action: 'pricing.provider.created', resourceType: 'pricing_provider', resourceId: String(p.id), organizationId: null, newValue: this.presentProvider(p), metadata: { reason: input.reason } }, tx);
        return p;
      });
      return this.presentProvider(created);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'A provider with this name already exists', [{ path: 'name', message: 'Choose another name' }]);
      throw err;
    }
  }

  async updateProvider(actor: Actor, id: number, input: ProviderInput) {
    platformOnly(actor);
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const before = await tx.pricingProvider.findUnique({ where: { id } });
        if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
        const rates = await tx.schemeRate.count({ where: { providerId: id } });
        if (rates && before.service !== input.service) throw new AppError(ErrorCode.CONFLICT, 'Schemes already price this provider, so its service cannot change', [{ path: 'service', message: 'Locked while schemes use it' }]);
        if (before.isActive && !input.is_active) {
          const schemes = await tx.scheme.count({ where: { status: 'ACTIVE', rates: { some: { providerId: id } } } });
          if (schemes) throw new AppError(ErrorCode.CONFLICT, `${schemes} active scheme(s) price this provider; remove its rates from them before switching it off`, [{ path: 'is_active', message: 'In use' }]);
        }
        await this.assertMethodsFree(tx, input, id);
        const p = await tx.pricingProvider.update({ where: { id }, data: { name: input.name, service: input.service, methods: input.methods, description: input.description, isActive: input.is_active, version: { increment: 1 } } });
        await this.audit.record({ action: 'pricing.provider.updated', resourceType: 'pricing_provider', resourceId: String(id), organizationId: null, oldValue: this.presentProvider(before), newValue: this.presentProvider(p), metadata: { reason: input.reason } }, tx);
        return p;
      });
      return this.presentProvider(updated);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'A provider with this name already exists', [{ path: 'name', message: 'Choose another name' }]);
      throw err;
    }
  }

  async removeProvider(actor: Actor, id: number, reason: string) {
    platformOnly(actor);
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.pricingProvider.findUnique({ where: { id } });
      if (!p) throw new AppError(ErrorCode.NOT_FOUND, 'Provider not found');
      if (await tx.schemeRate.count({ where: { providerId: id } })) throw new AppError(ErrorCode.CONFLICT, 'Schemes (including archived ones) have rates for this provider; switch it off instead');
      await tx.pricingProvider.delete({ where: { id } });
      await this.audit.record({ action: 'pricing.provider.removed', resourceType: 'pricing_provider', resourceId: String(id), organizationId: null, oldValue: this.presentProvider(p), metadata: { reason } }, tx);
    });
    return { removed: true };
  }

  // ---- Schemes ----------------------------------------------------------------------------------

  private presentScheme(s: SchemeWithRates, merchants = 0) {
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      status: s.status,
      is_default: s.isDefault,
      tax_rate: percent(s.taxRateMicros),
      version: s.version,
      merchants,
      rates: [...s.rates]
        .sort((a, b) => a.providerId - b.providerId || (a.minAmountMinor < b.minAmountMinor ? -1 : a.minAmountMinor > b.minAmountMinor ? 1 : 0))
        .map((r) => ({
          id: r.id,
          provider_id: r.providerId,
          provider_name: r.provider.name,
          service: r.provider.service,
          min_amount: minorToMajorString(r.minAmountMinor),
          max_amount: r.maxAmountMinor === null ? null : minorToMajorString(r.maxAmountMinor),
          type: r.valueType,
          value: presentValue(r.valueType, r.value),
          kind: r.value < 0n ? 'CHARGE' : r.value > 0n ? 'COMMISSION' : 'FREE',
        })),
      created_at: s.createdAt,
      updated_at: s.updatedAt,
    };
  }

  async list(actor: Actor) {
    platformOnly(actor);
    const [schemes, counts, unassigned] = await Promise.all([
      this.prisma.scheme.findMany({ include: { rates: { include: { provider: true } } }, orderBy: [{ status: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }] }),
      this.prisma.merchant.groupBy({ by: ['schemeId'], _count: true, where: { schemeId: { not: null } } }),
      this.prisma.merchant.count({ where: { schemeId: null } }),
    ]);
    const byScheme = new Map(counts.map((c) => [c.schemeId, c._count]));
    return { schemes: schemes.map((s) => this.presentScheme(s, byScheme.get(s.id) ?? 0)), merchants_without_scheme: unassigned };
  }

  async get(actor: Actor, id: string) {
    platformOnly(actor);
    const s = await this.prisma.scheme.findUnique({ where: { id }, include: { rates: { include: { provider: true } } } });
    if (!s) throw new AppError(ErrorCode.NOT_FOUND, 'Scheme not found');
    return this.presentScheme(s, await this.prisma.merchant.count({ where: { schemeId: id } }));
  }

  /** Validates rates against providers and each other; returns rows ready to insert. */
  private async rateRows(tx: Prisma.TransactionClient, schemeId: string, input: SchemeInput, existingProviders: Set<number>) {
    const ids = [...new Set(input.rates.map((r) => r.provider_id))];
    const providers = new Map((await tx.pricingProvider.findMany({ where: { id: { in: ids } } })).map((p) => [p.id, p]));
    const rows = input.rates.map((r, i) => {
      const p = providers.get(r.provider_id);
      // An inactive provider may stay in a scheme that already priced it, but cannot be added.
      if (!p || (!p.isActive && !existingProviders.has(p.id))) throw new AppError(ErrorCode.INVALID_REQUEST, `Rate ${i + 1}: provider ${r.provider_id} does not exist or is switched off`, [{ path: `rates.${i}.provider_id`, message: 'Unknown provider' }]);
      return { id: newId('schemeRate'), schemeId, providerId: r.provider_id, minAmountMinor: r.min_amount, maxAmountMinor: r.max_amount, valueType: r.type, value: parseValue(r.type, r.value) };
    });
    const overlap = findSlabOverlap(rows);
    if (overlap) {
      const [a, b] = overlap;
      const name = providers.get(a.providerId)!.name;
      const fmt = (r: typeof a) => `₹${minorToMajorString(r.minAmountMinor)}–${r.maxAmountMinor === null ? 'no limit' : `₹${minorToMajorString(r.maxAmountMinor)}`}`;
      throw new AppError(ErrorCode.INVALID_REQUEST, `${name}: slabs ${fmt(a)} and ${fmt(b)} overlap`, [{ path: `rates.${rows.indexOf(b)}.min_amount`, message: 'Overlaps another slab' }]);
    }
    return rows;
  }

  private async withUniqueName<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'An active scheme with this name already exists', [{ path: 'name', message: 'Choose another name' }]);
      throw err;
    }
  }

  async create(actor: Actor, input: SchemeInput) {
    platformOnly(actor);
    const id = newId('scheme');
    await this.withUniqueName(() =>
      this.prisma.$transaction(async (tx) => {
        const rates = await this.rateRows(tx, id, input, new Set());
        await tx.scheme.create({ data: { id, name: input.name, description: input.description, taxRateMicros: parseRateMicros(input.tax_rate), createdById: actor.userId } });
        await tx.schemeRate.createMany({ data: rates });
        const created = await tx.scheme.findUniqueOrThrow({ where: { id }, include: { rates: { include: { provider: true } } } });
        await this.audit.record({ action: 'pricing.scheme.created', resourceType: 'scheme', resourceId: id, organizationId: null, newValue: this.presentScheme(created), metadata: { reason: input.reason } }, tx);
      }),
    );
    return this.get(actor, id);
  }

  /** Rates are replaced as a whole; transactions already priced keep their snapshot. */
  async update(actor: Actor, id: string, input: SchemeInput) {
    platformOnly(actor);
    await this.withUniqueName(() =>
      this.prisma.$transaction(async (tx) => {
        const before = await tx.scheme.findUnique({ where: { id }, include: { rates: { include: { provider: true } } } });
        if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Scheme not found');
        if (before.status !== 'ACTIVE') throw new AppError(ErrorCode.CONFLICT, 'Archived schemes cannot be edited');
        const bumped = await tx.scheme.updateMany({
          where: { id, ...(input.version ? { version: input.version } : {}) },
          data: { name: input.name, description: input.description, taxRateMicros: parseRateMicros(input.tax_rate), version: { increment: 1 } },
        });
        if (bumped.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Someone else changed this scheme; reload and try again');
        const rates = await this.rateRows(tx, id, input, new Set(before.rates.map((r) => r.providerId)));
        await tx.schemeRate.deleteMany({ where: { schemeId: id } });
        await tx.schemeRate.createMany({ data: rates });
        const after = await tx.scheme.findUniqueOrThrow({ where: { id }, include: { rates: { include: { provider: true } } } });
        await this.audit.record({ action: 'pricing.scheme.updated', resourceType: 'scheme', resourceId: id, organizationId: null, oldValue: this.presentScheme(before), newValue: this.presentScheme(after), metadata: { reason: input.reason, severity: 'HIGH' } }, tx);
      }),
    );
    return this.get(actor, id);
  }

  async setDefault(actor: Actor, schemeId: string | null, reason: string) {
    platformOnly(actor);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.scheme.findFirst({ where: { isDefault: true, status: 'ACTIVE' }, select: { id: true, name: true } });
      if (schemeId) {
        const s = await tx.scheme.findUnique({ where: { id: schemeId } });
        if (!s || s.status !== 'ACTIVE') throw new AppError(ErrorCode.NOT_FOUND, 'Scheme not found or archived');
      }
      await tx.scheme.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      if (schemeId) await tx.scheme.update({ where: { id: schemeId }, data: { isDefault: true, version: { increment: 1 } } });
      await this.audit.record({ action: 'pricing.scheme.default_changed', resourceType: 'scheme', resourceId: schemeId, organizationId: null, oldValue: { scheme_id: before?.id ?? null, name: before?.name ?? null }, newValue: { scheme_id: schemeId }, metadata: { reason, severity: 'HIGH' } }, tx);
    });
    return this.list(actor);
  }

  async archive(actor: Actor, id: string, reason: string) {
    platformOnly(actor);
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.scheme.findUnique({ where: { id } });
      if (!s || s.status !== 'ACTIVE') throw new AppError(ErrorCode.NOT_FOUND, 'Scheme not found or already archived');
      if (s.isDefault) throw new AppError(ErrorCode.CONFLICT, 'This is the default scheme; choose another default first');
      const merchants = await tx.merchant.count({ where: { schemeId: id } });
      if (merchants) throw new AppError(ErrorCode.CONFLICT, `${merchants} merchant(s) are on this scheme; move them to another scheme first`);
      await tx.scheme.update({ where: { id }, data: { status: 'ARCHIVED', version: { increment: 1 } } });
      await this.audit.record({ action: 'pricing.scheme.archived', resourceType: 'scheme', resourceId: id, organizationId: null, metadata: { reason } }, tx);
    });
    return { archived: true };
  }

  // ---- Merchants --------------------------------------------------------------------------------

  /** Merchants with their assigned scheme and what actually prices them right now. */
  async merchants(actor: Actor, query: z.output<typeof schemeMerchantsQuerySchema>) {
    platformOnly(actor);
    const where: Prisma.MerchantWhereInput = {
      ...(query.scheme === 'none' ? { schemeId: null } : query.scheme ? { schemeId: query.scheme } : {}),
      ...(query.q ? { OR: [{ id: query.q }, { organization: { name: { contains: query.q, mode: 'insensitive' } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.merchant.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        select: { id: true, status: true, resellerId: true, schemeId: true, scheme: { select: { id: true, name: true } }, organization: { select: { name: true } } },
      }),
      this.prisma.merchant.count({ where }),
    ]);
    const page = rows.slice(0, query.limit);
    const resellerIds = [...new Set(page.map((m) => m.resellerId).filter((x): x is string => !!x))];
    const resellers = new Map((await this.prisma.organization.findMany({ where: { id: { in: resellerIds } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    const data = await Promise.all(page.map(async (m) => ({ id: m.id, name: m.organization.name, status: m.status, reseller: m.resellerId ? { id: m.resellerId, name: resellers.get(m.resellerId) ?? '' } : null, scheme: m.scheme, effective: await this.effective(m.id) })));
    return { data, total, next_cursor: rows.length > query.limit ? page.at(-1)!.id : null };
  }

  private async effective(merchantId: string) {
    const r = await this.pricing.resolveMerchantPricing(merchantId);
    if (!r) return { source: 'NONE' as const, name: null, id: null };
    return r.source === 'RATE_CARD' ? { source: r.source, name: r.plan.name, id: r.plan.id } : { source: r.source, name: r.scheme.name, id: r.scheme.id };
  }

  async merchantPricing(actor: Actor, merchantId: string) {
    platformOnly(actor);
    const m = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true, resellerId: true, scheme: { select: { id: true, name: true } } } });
    if (!m) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    const r = await this.pricing.resolveMerchantPricing(merchantId);
    const scheme = r && r.source !== 'RATE_CARD' ? await this.prisma.scheme.findUniqueOrThrow({ where: { id: r.scheme.id }, include: { rates: { include: { provider: true } } } }) : null;
    return { merchant_id: m.id, has_reseller: !!m.resellerId, assigned: m.scheme, effective: await this.effective(merchantId), scheme: scheme ? this.presentScheme(scheme) : null };
  }

  async assign(actor: Actor, input: z.output<typeof assignSchemeSchema>) {
    platformOnly(actor);
    return this.prisma.$transaction(async (tx) => {
      const scheme = input.scheme_id ? await tx.scheme.findUnique({ where: { id: input.scheme_id } }) : null;
      if (input.scheme_id && (!scheme || scheme.status !== 'ACTIVE')) throw new AppError(ErrorCode.NOT_FOUND, 'Scheme not found or archived');
      const label = scheme ? { scheme_id: scheme.id, name: scheme.name } : { scheme_id: null, name: 'Default scheme' };
      if (input.target === 'ALL') {
        const where: Prisma.MerchantWhereInput = input.include_reseller_merchants ? {} : { resellerId: null };
        const { count } = await tx.merchant.updateMany({ where, data: { schemeId: input.scheme_id } });
        await this.audit.record({ action: 'pricing.scheme.assigned_all', resourceType: 'scheme', resourceId: input.scheme_id, organizationId: null, newValue: { ...label, merchants: count, include_reseller_merchants: input.include_reseller_merchants }, metadata: { reason: input.reason, severity: 'HIGH' } }, tx);
        return { updated: count };
      }
      const ids = [...new Set(input.merchant_ids)];
      const found = await tx.merchant.findMany({ where: { id: { in: ids } }, select: { id: true, schemeId: true } });
      if (found.length !== ids.length) throw new AppError(ErrorCode.INVALID_REQUEST, `${ids.length - found.length} merchant(s) not found`, [{ path: 'merchant_ids', message: 'Unknown merchant' }]);
      await tx.merchant.updateMany({ where: { id: { in: ids } }, data: { schemeId: input.scheme_id } });
      for (const m of found) {
        await this.audit.record({ action: 'pricing.scheme.assigned', resourceType: 'merchant', resourceId: m.id, organizationId: m.id, oldValue: { scheme_id: m.schemeId }, newValue: label, metadata: { reason: input.reason } }, tx);
      }
      return { updated: found.length };
    });
  }

  /** What a transaction would cost under a scheme, or under whatever prices a merchant now. */
  async preview(actor: Actor, input: z.output<typeof schemePreviewSchema>) {
    platformOnly(actor);
    const service = (['IMPS', 'NEFT', 'RTGS', 'UPI'] as string[]).includes(input.method) ? 'PAYOUT' : 'PAYIN';
    let scheme;
    if (input.scheme_id) {
      scheme = await this.prisma.scheme.findUnique({ where: { id: input.scheme_id }, include: { rates: true } });
      if (!scheme) throw new AppError(ErrorCode.NOT_FOUND, 'Scheme not found');
    } else if (input.merchant_id) {
      const r = await this.pricing.resolveMerchantPricing(input.merchant_id);
      if (!r) throw new AppError(ErrorCode.INVALID_REQUEST, 'No pricing applies to this merchant');
      if (r.source === 'RATE_CARD') throw new AppError(ErrorCode.INVALID_REQUEST, `This merchant is priced by the rate card "${r.plan.name}", not a scheme`);
      scheme = r.scheme;
    } else throw new AppError(ErrorCode.INVALID_REQUEST, 'Give scheme_id or merchant_id');
    const q = await this.pricing.schemeQuote(scheme, service, input.method, input.amount);
    const m = (v: bigint) => minorToMajorString(v);
    return {
      service,
      provider: { id: q.provider.id, name: q.provider.name },
      slab: { min_amount: m(q.rate.minAmountMinor), max_amount: q.rate.maxAmountMinor === null ? null : m(q.rate.maxAmountMinor), type: q.rate.valueType, value: presentValue(q.rate.valueType, q.rate.value) },
      amount: m(input.amount),
      fee: m(q.feeMinor),
      tax: m(q.taxMinor),
      commission: m(q.commissionMinor),
      // Payin: what the merchant is credited. Payout: what the merchant is debited.
      merchant_net: service === 'PAYIN' ? m(input.amount - q.feeMinor - q.taxMinor + q.commissionMinor) : m(input.amount + q.feeMinor + q.taxMinor - q.commissionMinor),
    };
  }
}
