import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pay2all/auth';
import { Prisma, type PrismaClient, type RoutingPolicy } from '@pay2all/database';
import { decideRoute, type ProviderInfo, type RouteRule, type RoutingDecision, type RoutingRequest, smoothedConversion } from '@pay2all/providers';
import { ErrorCode } from '@pay2all/types';
import type { listRoutesQuerySchema, routeSchema, routingPolicySchema, routingScoresQuerySchema, simulateRouteSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ProviderRegistryService } from './provider-registry.service';
import { presentRoute } from './providers.presenter';

const ROUTE_INCLUDE = { provider: { select: { code: true, name: true, status: true } } } satisfies Prisma.ProviderRouteInclude;

type Service = 'PAYIN' | 'PAYOUT';
type Policy = Pick<RoutingPolicy, 'strategy' | 'windowMinutes' | 'minSamples' | 'explorePercent' | 'version'> & { updatedAt: Date | null };
interface Conversion {
  success: number;
  failed: number;
  smoothed: number;
}
const DEFAULT_POLICY: Policy = { strategy: 'PRIORITY', windowMinutes: 60, minSamples: 20, explorePercent: 5, version: 0, updatedAt: null };
/** Used as the prior until the whole method has enough completed transactions in the window. */
const DEFAULT_PRIOR = 0.9;
const POLICY_TTL_MS = 15_000;
const CONVERSION_TTL_MS = 30_000;
/** Same success / failure definitions as analytics (docs/ANALYTICS.md §1). */
const OUTCOMES = {
  PAYIN: { table: Prisma.raw('payments'), dim: Prisma.raw('method::text'), ok: Prisma.raw('capture_journal_id IS NOT NULL'), failed: Prisma.raw(`status IN ('FAILED', 'EXPIRED')`) },
  PAYOUT: { table: Prisma.raw('payouts'), dim: Prisma.raw('mode'), ok: Prisma.raw('settle_journal_id IS NOT NULL'), failed: Prisma.raw(`status = 'FAILED'`) },
} as const;

/** Routing rules management plus the decision function used by Payin/Payout. */
@Injectable()
export class RoutingService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: ProviderRegistryService,
    private readonly audit: AuditService,
  ) {}

  /** Overridable in tests (exploration draws). */
  random: () => number = Math.random;
  private readonly policies = new Map<Service, { at: number; value: Policy }>();
  private readonly conversions = new Map<string, { at: number; value: Map<string, Conversion> }>();

  async policy(service: Service): Promise<Policy> {
    const hit = this.policies.get(service);
    if (hit && Date.now() - hit.at < POLICY_TTL_MS) return hit.value;
    const row = await this.prisma.routingPolicy.findUnique({ where: { service } });
    const value = row ?? DEFAULT_POLICY;
    this.policies.set(service, { at: Date.now(), value });
    return value;
  }

  /**
   * Recent conversion per provider for one method: completed transactions created in the window,
   * smoothed towards the method's pooled rate (docs/ROUTING.md §2). Cached per node for 30 s.
   */
  async conversion(service: Service, method: string, policy: Policy): Promise<Map<string, Conversion>> {
    const key = `${service}:${method}:${policy.windowMinutes}:${policy.minSamples}`;
    const hit = this.conversions.get(key);
    if (hit && Date.now() - hit.at < CONVERSION_TTL_MS) return hit.value;
    const o = OUTCOMES[service];
    const since = new Date(Date.now() - policy.windowMinutes * 60_000);
    const rows = await this.prisma.$queryRaw<{ provider_id: string; success: bigint; failed: bigint }[]>`
      SELECT provider_id, COUNT(*) FILTER (WHERE ${o.ok}) AS success, COUNT(*) FILTER (WHERE ${o.failed}) AS failed
        FROM ${o.table}
       WHERE provider_id IS NOT NULL AND ${o.dim} = ${method} AND created_at >= ${since}
       GROUP BY 1`;
    const success = rows.reduce((n, r) => n + Number(r.success), 0);
    const completed = success + rows.reduce((n, r) => n + Number(r.failed), 0);
    const prior = completed >= policy.minSamples ? success / completed : DEFAULT_PRIOR;
    const value = new Map(rows.map((r) => [r.provider_id, { success: Number(r.success), failed: Number(r.failed), smoothed: smoothedConversion(Number(r.success), Number(r.failed), prior, policy.minSamples) }]));
    // Providers with nothing completed yet get the prior itself.
    value.set('*', { success: 0, failed: 0, smoothed: prior });
    this.conversions.set(key, { at: Date.now(), value });
    return value;
  }

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
    const policy = await this.policy(req.service);
    const request = { ...req, resellerId: merchant.resellerId, riskCategory: merchant.riskCategory, at: req.at ?? new Date() };
    if (policy.strategy !== 'SCORE') return decideRoute(rules, infos, request);
    const conv = await this.conversion(req.service, req.method, policy);
    const prior = conv.get('*')!.smoothed;
    const conversion = new Map(providers.map((p) => [p.id, conv.get(p.id)?.smoothed ?? prior]));
    return decideRoute(rules, infos, request, { strategy: 'SCORE', conversion, explore: policy.explorePercent / 100, random: this.random });
  }

  private presentPolicy(service: Service, p: Policy) {
    return { service, strategy: p.strategy, window_minutes: p.windowMinutes, min_samples: p.minSamples, explore_percent: p.explorePercent, version: p.version, updated_at: p.updatedAt };
  }

  async listPolicies() {
    const rows = await this.prisma.routingPolicy.findMany();
    return (['PAYIN', 'PAYOUT'] as const).map((s) => this.presentPolicy(s, rows.find((r) => r.service === s) ?? DEFAULT_POLICY));
  }

  async savePolicy(actor: Actor, service: Service, input: z.output<typeof routingPolicySchema>) {
    const data = { strategy: input.strategy, windowMinutes: input.window_minutes, minSamples: input.min_samples, explorePercent: input.explore_percent, updatedById: actor.userId };
    const saved = await this.prisma.$transaction(async (tx) => {
      const before = await tx.routingPolicy.findUnique({ where: { service } });
      const after = await tx.routingPolicy.upsert({ where: { service }, create: { service, ...data }, update: { ...data, version: { increment: 1 } } });
      await this.audit.record({ action: 'routing.policy.updated', resourceType: 'routing_policy', resourceId: service, organizationId: null, oldValue: this.presentPolicy(service, before ?? DEFAULT_POLICY), newValue: this.presentPolicy(service, after), metadata: { reason: input.reason, severity: 'HIGH' } }, tx);
      return after;
    });
    this.policies.delete(service);
    return this.presentPolicy(service, saved);
  }

  /** Scoreboard: what SCORE routing currently thinks of each provider for one method. */
  async scores(q: z.output<typeof routingScoresQuerySchema>) {
    const stored = await this.policy(q.service);
    // Show scores with the configured window even while the strategy is PRIORITY, so a switch can be judged first.
    const conv = await this.conversion(q.service, q.method, stored);
    const prior = conv.get('*')!.smoothed;
    const providers = await this.prisma.provider.findMany({ where: { kind: { in: [q.service, 'BOTH'] } }, orderBy: { code: 'asc' } });
    const rows = await Promise.all(
      providers.map(async (p) => {
        const c = conv.get(p.id);
        const health = (await this.registry.metrics(p.id, q.service)).successRate;
        const smoothed = c?.smoothed ?? prior;
        return {
          provider_id: p.id,
          code: p.code,
          name: p.name,
          status: p.status,
          completed: (c?.success ?? 0) + (c?.failed ?? 0),
          success: c?.success ?? 0,
          conversion: c && c.success + c.failed ? Math.round((c.success / (c.success + c.failed)) * 10_000) / 10_000 : null,
          smoothed: Math.round(smoothed * 10_000) / 10_000,
          api_success_rate: health,
          score: Math.round(smoothed * (health ?? 1) * 10_000) / 10_000,
        };
      }),
    );
    return { policy: this.presentPolicy(q.service, stored), method: q.method, prior: Math.round(prior * 10_000) / 10_000, providers: rows.sort((a, b) => b.score - a.score) };
  }

  async simulate(input: z.output<typeof simulateRouteSchema>) {
    const decision = await this.decide({ service: input.service, merchantId: input.merchant_id, amountMinor: input.amount, method: input.method, at: input.at ? new Date(input.at) : undefined });
    return {
      strategy: (await this.policy(input.service)).strategy,
      candidates: decision.candidates.map((c, i) => ({ order: i + 1, provider_id: c.providerId, provider_code: c.providerCode, route_id: c.routeId, route_name: c.routeName, tier: c.tier, priority: c.priority, degraded: c.degraded, score: c.score ?? null, explored: c.explored ?? false })),
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
