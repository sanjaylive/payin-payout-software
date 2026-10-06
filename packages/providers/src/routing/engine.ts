/**
 * Smart routing engine (pure). Given routing rules, provider state and a transaction, returns an
 * ordered candidate list PRIMARY → SECONDARY → FALLBACK plus an explanation for every rule, so an
 * operator can always answer "why did this go to provider X?".
 */

export type RouteTier = 'PRIMARY' | 'SECONDARY' | 'FALLBACK';
export type ProviderState = 'ACTIVE' | 'DEGRADED' | 'DOWN' | 'MAINTENANCE' | 'DISABLED';

export interface RouteRule {
  id: string;
  name: string;
  service: 'PAYIN' | 'PAYOUT';
  tier: RouteTier;
  priority: number;
  isActive: boolean;
  providerId: string;
  merchantId: string | null;
  resellerId: string | null;
  method: string | null;
  minAmountMinor: bigint | null;
  maxAmountMinor: bigint | null;
  riskCategories: string[];
  timeWindow: { start: string; end: string; days?: number[] } | null;
}

export interface ProviderInfo {
  id: string;
  code: string;
  kind: 'PAYIN' | 'PAYOUT' | 'BOTH';
  status: ProviderState;
  capabilities: { payin_methods?: string[]; payout_modes?: string[]; min_amount_minor?: string | number; max_amount_minor?: string | number };
  costs: { payin_rate_micros?: string | number; payout_flat_minor?: string | number };
  health?: { successRate: number | null; p95LatencyMs: number | null };
}

export interface RoutingRequest {
  service: 'PAYIN' | 'PAYOUT';
  merchantId: string;
  resellerId: string | null;
  amountMinor: bigint;
  method: string;
  riskCategory: string | null;
  at: Date;
}

export interface Candidate {
  routeId: string;
  routeName: string;
  providerId: string;
  providerCode: string;
  tier: RouteTier;
  priority: number;
  degraded: boolean;
}

export interface RouteEvaluation {
  routeId: string;
  routeName: string;
  providerCode: string;
  tier: RouteTier;
  selected: boolean;
  reasons: string[];
}

export interface RoutingDecision {
  candidates: Candidate[];
  evaluations: RouteEvaluation[];
}

const TIER_ORDER: Record<RouteTier, number> = { PRIMARY: 0, SECONDARY: 1, FALLBACK: 2 };
const UNAVAILABLE: ProviderState[] = ['DOWN', 'MAINTENANCE', 'DISABLED'];
const IST_OFFSET_MIN = 330;

function istClock(at: Date): { minutes: number; isoDay: number } {
  const ist = new Date(at.getTime() + IST_OFFSET_MIN * 60_000);
  const day = ist.getUTCDay(); // 0 = Sunday
  return { minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(), isoDay: day === 0 ? 7 : day };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** IST time window; supports windows that cross midnight (e.g. 22:00–06:00). */
export function inTimeWindow(window: RouteRule['timeWindow'], at: Date): boolean {
  if (!window) return true;
  const { minutes, isoDay } = istClock(at);
  if (window.days?.length && !window.days.includes(isoDay)) return false;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

const specificity = (r: RouteRule) => (r.merchantId ? 2 : r.resellerId ? 1 : 0);
const num = (v: string | number | undefined) => (v === undefined ? undefined : BigInt(v));

export function decideRoute(rules: RouteRule[], providers: ProviderInfo[], req: RoutingRequest): RoutingDecision {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const evaluations: RouteEvaluation[] = [];
  const eligible: (Candidate & { specificity: number; successRate: number; cost: bigint; p95: number })[] = [];

  for (const rule of rules) {
    const provider = byId.get(rule.providerId);
    const reasons: string[] = [];
    if (!provider) {
      evaluations.push({ routeId: rule.id, routeName: rule.name, providerCode: '?', tier: rule.tier, selected: false, reasons: ['provider not found'] });
      continue;
    }
    if (!rule.isActive) reasons.push('route inactive');
    if (rule.service !== req.service) reasons.push(`route is for ${rule.service}`);
    if (rule.merchantId && rule.merchantId !== req.merchantId) reasons.push('different merchant');
    if (rule.resellerId && rule.resellerId !== req.resellerId) reasons.push('different reseller');
    if (rule.method && rule.method !== req.method) reasons.push(`method ${rule.method} only`);
    if (rule.minAmountMinor !== null && req.amountMinor < rule.minAmountMinor) reasons.push('amount below route minimum');
    if (rule.maxAmountMinor !== null && req.amountMinor > rule.maxAmountMinor) reasons.push('amount above route maximum');
    if (rule.riskCategories.length && (!req.riskCategory || !rule.riskCategories.includes(req.riskCategory))) reasons.push('risk category not covered');
    if (!inTimeWindow(rule.timeWindow, req.at)) reasons.push('outside time window');

    // Provider-level checks.
    if (provider.kind !== 'BOTH' && provider.kind !== req.service) reasons.push(`provider does not support ${req.service}`);
    if (UNAVAILABLE.includes(provider.status)) reasons.push(`provider ${provider.status.toLowerCase()}`);
    const supported = req.service === 'PAYIN' ? provider.capabilities.payin_methods : provider.capabilities.payout_modes;
    if (supported && !supported.includes(req.method)) reasons.push(`provider does not support ${req.method}`);
    const pMin = num(provider.capabilities.min_amount_minor);
    const pMax = num(provider.capabilities.max_amount_minor);
    if (pMin !== undefined && req.amountMinor < pMin) reasons.push('amount below provider minimum');
    if (pMax !== undefined && req.amountMinor > pMax) reasons.push('amount above provider maximum');

    if (reasons.length === 0) {
      reasons.push(`matched (${rule.merchantId ? 'merchant' : rule.resellerId ? 'reseller' : 'global'} rule)`);
      if (provider.status === 'DEGRADED') reasons.push('provider degraded — ranked after healthy candidates in its tier');
      eligible.push({
        routeId: rule.id,
        routeName: rule.name,
        providerId: provider.id,
        providerCode: provider.code,
        tier: rule.tier,
        priority: rule.priority,
        degraded: provider.status === 'DEGRADED',
        specificity: specificity(rule),
        successRate: provider.health?.successRate ?? 1,
        cost: num(req.service === 'PAYIN' ? provider.costs.payin_rate_micros : provider.costs.payout_flat_minor) ?? 0n,
        p95: provider.health?.p95LatencyMs ?? 0,
      });
      evaluations.push({ routeId: rule.id, routeName: rule.name, providerCode: provider.code, tier: rule.tier, selected: true, reasons });
    } else {
      evaluations.push({ routeId: rule.id, routeName: rule.name, providerCode: provider.code, tier: rule.tier, selected: false, reasons });
    }
  }

  eligible.sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      Number(a.degraded) - Number(b.degraded) ||
      b.specificity - a.specificity ||
      a.priority - b.priority ||
      b.successRate - a.successRate ||
      (a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : 0) ||
      a.p95 - b.p95,
  );

  // One candidate per provider (the best-ranked rule wins).
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const c of eligible) {
    if (seen.has(c.providerId)) continue;
    seen.add(c.providerId);
    candidates.push({ routeId: c.routeId, routeName: c.routeName, providerId: c.providerId, providerCode: c.providerCode, tier: c.tier, priority: c.priority, degraded: c.degraded });
  }
  return { candidates, evaluations };
}
