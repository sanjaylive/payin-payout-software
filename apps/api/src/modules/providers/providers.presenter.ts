import type { Prisma } from '@pay2all/database';
import { ADAPTERS, type HealthMetrics } from '@pay2all/providers';

export const PROVIDER_INCLUDE = { credentials: { select: { environment: true, fingerprints: true, rotatedAt: true, rotatedById: true } } } satisfies Prisma.ProviderInclude;
type ProviderRow = Prisma.ProviderGetPayload<{ include: typeof PROVIDER_INCLUDE }>;

export function presentMetrics(m: HealthMetrics | null) {
  if (!m) return null;
  return {
    window_minutes: m.windowMinutes,
    requests: m.requests,
    success_rate: m.successRate,
    failure_rate: m.failureRate,
    timeout_rate: m.timeoutRate,
    avg_latency_ms: m.avgLatencyMs,
    p95_latency_ms: m.p95LatencyMs,
    p99_latency_ms: m.p99LatencyMs,
    last_success_at: m.lastSuccessAt,
    last_failure_at: m.lastFailureAt,
  };
}

/** Credentials are summarised by key names and last-4 fingerprints only — never values. */
export function presentProvider(p: ProviderRow, health?: { payin?: HealthMetrics | null; payout?: HealthMetrics | null }) {
  const adapter = ADAPTERS[p.adapter];
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    kind: p.kind,
    adapter: p.adapter,
    adapter_label: adapter?.label ?? p.adapter,
    required_credentials: adapter?.credentialKeys ?? [],
    environment: p.environment,
    status: p.status,
    status_source: p.statusSource,
    status_reason: p.statusReason,
    status_changed_at: p.statusChangedAt,
    capabilities: p.capabilities,
    config: p.config,
    costs: p.costs,
    credentials: p.credentials.map((c) => ({ environment: c.environment, fingerprints: c.fingerprints, rotated_at: c.rotatedAt, rotated_by_id: c.rotatedById })),
    health: health ? { payin: presentMetrics(health.payin ?? null), payout: presentMetrics(health.payout ?? null) } : undefined,
    version: p.version,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

type RouteRow = Prisma.ProviderRouteGetPayload<{ include: { provider: { select: { code: true; name: true; status: true } } } }>;

export function presentRoute(r: RouteRow) {
  const major = (v: bigint | null) => (v === null ? null : `${v / 100n}.${String(v % 100n).padStart(2, '0')}`);
  return {
    id: r.id,
    name: r.name,
    service: r.service,
    tier: r.tier,
    priority: r.priority,
    is_active: r.isActive,
    provider: { id: r.providerId, code: r.provider.code, name: r.provider.name, status: r.provider.status },
    merchant_id: r.merchantId,
    reseller_id: r.resellerId,
    method: r.method,
    min_amount: major(r.minAmountMinor),
    max_amount: major(r.maxAmountMinor),
    risk_categories: r.riskCategories,
    time_window: r.timeWindow,
    version: r.version,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}
