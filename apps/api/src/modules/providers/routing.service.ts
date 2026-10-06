import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import type { Prisma, PrismaClient } from '@pay2all/database';
import { decideRoute, type ProviderInfo, type RouteRule, type RoutingDecision, type RoutingRequest } from '@pay2all/providers';
import { ErrorCode } from '@pay2all/types';
import type { listRoutesQuerySchema, routeSchema, simulateRouteSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ProviderRegistryService } from './provider-registry.service';
import { presentRoute } from './providers.presenter';

const ROUTE_INCLUDE = { provider: { select: { code: true, name: true, status: true } } } satisfies Prisma.ProviderRouteInclude;

/** Routing rules management plus the decision function used by Payin/Payout. */
@Injectable()
export class RoutingService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: ProviderRegistryService,
    private readonly audit: AuditService,
  ) {}

  /** Decide candidates for a transaction (the payment/payout services call this). */
  async decide(req: Omit<RoutingRequest, 'resellerId' | 'riskCategory' | 'at'> & { at?: Date }): Promise<RoutingDecision> {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: req.merchantId }, select: { resellerId: true, riskCategory: true } });
    if (!merchant) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    const [routes, providers] = await Promise.all([
      this.prisma.providerRoute.findMany({ where: { service: req.service, isActive: true } }),
      this.prisma.provider.findMany(),
    ]);
    const infos: ProviderInfo[] = await Promise.all(
      providers.map(async (p) => {
        const m = await this.registry.metrics(p.id, req.service);
        return {
          id: p.id,
          code: p.code,
          kind: p.kind,
          status: p.status,
          capabilities: p.capabilities as ProviderInfo['capabilities'],
          costs: p.costs as ProviderInfo['costs'],
          health: { successRate: m.successRate, p95LatencyMs: m.p95LatencyMs },
        };
      }),
    );
    const rules: RouteRule[] = routes.map((r) => ({
      id: r.id,
      name: r.name,
      service: r.service as 'PAYIN' | 'PAYOUT',
      tier: r.tier,
      priority: r.priority,
      isActive: r.isActive,
      providerId: r.providerId,
      merchantId: r.merchantId,
      resellerId: r.resellerId,
      method: r.method,
      minAmountMinor: r.minAmountMinor,
      maxAmountMinor: r.maxAmountMinor,
      riskCategories: r.riskCategories,
      timeWindow: r.timeWindow as RouteRule['timeWindow'],
    }));
    return decideRoute(rules, infos, { ...req, resellerId: merchant.resellerId, riskCategory: merchant.riskCategory, at: req.at ?? new Date() });
  }

  async simulate(input: z.output<typeof simulateRouteSchema>) {
    const decision = await this.decide({ service: input.service, merchantId: input.merchant_id, amountMinor: input.amount, method: input.method, at: input.at ? new Date(input.at) : undefined });
    return {
      candidates: decision.candidates.map((c, i) => ({ order: i + 1, provider_id: c.providerId, provider_code: c.providerCode, route_id: c.routeId, route_name: c.routeName, tier: c.tier, priority: c.priority, degraded: c.degraded })),
      evaluations: decision.evaluations.map((e) => ({ route_id: e.routeId, route_name: e.routeName, provider_code: e.providerCode, tier: e.tier, selected: e.selected, reasons: e.reasons })),
    };
  }

  async list(q: z.output<typeof listRoutesQuerySchema>) {
    const rows = await this.prisma.providerRoute.findMany({
      where: { AND: [q.service ? { service: q.service } : {}, q.provider_id ? { providerId: q.provider_id } : {}, keysetAfter(decodeCursor(q.cursor))] },
      include: ROUTE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, presentRoute);
  }

  private async validate(input: z.output<typeof routeSchema>) {
    const provider = await this.prisma.provider.findUnique({ where: { id: input.provider_id }, select: { kind: true } });
    if (!provider) throw new AppError(ErrorCode.INVALID_REQUEST, 'Provider not found');
    if (provider.kind !== 'BOTH' && provider.kind !== input.service) throw new AppError(ErrorCode.INVALID_REQUEST, `Provider does not support ${input.service}`);
    if (input.merchant_id && !(await this.prisma.merchant.count({ where: { id: input.merchant_id } }))) throw new AppError(ErrorCode.INVALID_REQUEST, 'Merchant not found');
    if (input.reseller_id && !(await this.prisma.organization.count({ where: { id: input.reseller_id, type: 'RESELLER' } }))) throw new AppError(ErrorCode.INVALID_REQUEST, 'Reseller not found');
  }

  private data(input: z.output<typeof routeSchema>) {
    return {
      name: input.name,
      service: input.service,
      tier: input.tier,
      priority: input.priority,
      providerId: input.provider_id,
      merchantId: input.merchant_id ?? null,
      resellerId: input.reseller_id ?? null,
      method: input.method ?? null,
      minAmountMinor: input.min_amount ?? null,
      maxAmountMinor: input.max_amount ?? null,
      riskCategories: input.risk_categories,
      timeWindow: (input.time_window ?? undefined) as Prisma.InputJsonValue | undefined,
      isActive: input.is_active,
    };
  }

  async create(actor: Actor, input: z.output<typeof routeSchema>) {
    await this.validate(input);
    const route = await this.prisma.$transaction(async (tx) => {
      const r = await tx.providerRoute.create({ data: { id: newId('providerRoute'), ...this.data(input), createdById: actor.userId }, include: ROUTE_INCLUDE });
      await this.audit.record({ action: 'routing.route.created', resourceType: 'provider_route', resourceId: r.id, organizationId: null, newValue: presentRoute(r) }, tx);
      return r;
    });
    return presentRoute(route);
  }

  async update(actor: Actor, id: string, input: z.output<typeof routeSchema>) {
    await this.validate(input);
    const route = await this.prisma.$transaction(async (tx) => {
      const before = await tx.providerRoute.findUnique({ where: { id }, include: ROUTE_INCLUDE });
      if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Route not found');
      const r = await tx.providerRoute.update({ where: { id }, data: { ...this.data(input), version: { increment: 1 } }, include: ROUTE_INCLUDE });
      await this.audit.record({ action: 'routing.route.updated', resourceType: 'provider_route', resourceId: id, organizationId: null, oldValue: presentRoute(before), newValue: presentRoute(r) }, tx);
      return r;
    });
    return presentRoute(route);
  }
}
