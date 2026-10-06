/**
 * Provider health (docs/ARCHITECTURE.md §9): rolling per-minute counters and recent latencies in
 * Redis, a pure metrics computation, and a circuit-breaker status decision.
 *
 * Status changes are applied by ONE writer (the worker's provider-health job) — API nodes only
 * record samples — so concurrent nodes can never flap a provider's status.
 */

export type HealthOutcome = 'SUCCESS' | 'FAILURE' | 'TIMEOUT';
export type BreakerStatus = 'ACTIVE' | 'DEGRADED' | 'DOWN';

/** The subset of ioredis we use (keeps this package free of a Redis dependency). */
export interface RedisLike {
  multi(): {
    hincrby(key: string, field: string, by: number): unknown;
    expire(key: string, seconds: number): unknown;
    lpush(key: string, value: string): unknown;
    ltrim(key: string, start: number, stop: number): unknown;
    set(key: string, value: string): unknown;
    exec(): Promise<unknown>;
  };
  hgetall(key: string): Promise<Record<string, string>>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  get(key: string): Promise<string | null>;
}

export interface HealthMetrics {
  windowMinutes: number;
  requests: number;
  successes: number;
  failures: number;
  timeouts: number;
  successRate: number | null;
  failureRate: number | null;
  timeoutRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

export interface BreakerPolicy {
  /** Minimum requests in the window before the breaker judges anything. */
  minSamples: number;
  /** (failures + timeouts) / requests at or above which the provider is DOWN. */
  downErrorRate: number;
  /** … at or above which the provider is DEGRADED. */
  degradedErrorRate: number;
  /** p95 latency at or above which the provider is DEGRADED. */
  degradedP95Ms: number;
}

export const DEFAULT_BREAKER: BreakerPolicy = { minSamples: 20, downErrorRate: 0.5, degradedErrorRate: 0.15, degradedP95Ms: 5_000 };

const WINDOW_MINUTES = 15;
const LATENCY_SAMPLES = 500;

const key = (providerId: string, service: string) => `ph:${providerId}:${service}`;
const minuteOf = (at: Date) => Math.floor(at.getTime() / 60_000);

export async function recordSample(redis: RedisLike, providerId: string, service: string, outcome: HealthOutcome, latencyMs: number, at = new Date()): Promise<void> {
  const base = key(providerId, service);
  const bucket = `${base}:m:${minuteOf(at)}`;
  const tx = redis.multi();
  tx.hincrby(bucket, 'req', 1);
  tx.hincrby(bucket, outcome === 'SUCCESS' ? 'ok' : outcome === 'TIMEOUT' ? 'timeout' : 'fail', 1);
  tx.hincrby(bucket, 'lat', Math.max(0, Math.round(latencyMs)));
  tx.expire(bucket, (WINDOW_MINUTES + 5) * 60);
  tx.lpush(`${base}:lat`, String(Math.round(latencyMs)));
  tx.ltrim(`${base}:lat`, 0, LATENCY_SAMPLES - 1);
  tx.set(`${base}:${outcome === 'SUCCESS' ? 'last_ok' : 'last_fail'}`, at.toISOString());
  await tx.exec();
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function computeMetrics(buckets: Record<string, string>[], latencies: number[], lastOk: string | null, lastFail: string | null): HealthMetrics {
  let requests = 0;
  let successes = 0;
  let failures = 0;
  let timeouts = 0;
  let latencySum = 0;
  for (const b of buckets) {
    requests += Number(b.req ?? 0);
    successes += Number(b.ok ?? 0);
    failures += Number(b.fail ?? 0);
    timeouts += Number(b.timeout ?? 0);
    latencySum += Number(b.lat ?? 0);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const rate = (n: number) => (requests ? n / requests : null);
  return {
    windowMinutes: WINDOW_MINUTES,
    requests,
    successes,
    failures,
    timeouts,
    successRate: rate(successes),
    failureRate: rate(failures),
    timeoutRate: rate(timeouts),
    avgLatencyMs: requests ? Math.round(latencySum / requests) : null,
    p95LatencyMs: percentile(sorted, 95),
    p99LatencyMs: percentile(sorted, 99),
    lastSuccessAt: lastOk ? new Date(lastOk) : null,
    lastFailureAt: lastFail ? new Date(lastFail) : null,
  };
}

/**
 * Metrics over the rolling window. `since` (the last status change) trims the window so a provider
 * that just recovered isn't immediately re-tripped by failures recorded before it recovered.
 */
export async function readMetrics(redis: RedisLike, providerId: string, service: string, at = new Date(), since?: Date): Promise<HealthMetrics> {
  const base = key(providerId, service);
  const now = minuteOf(at);
  const minutes = since ? Math.max(1, Math.min(WINDOW_MINUTES, now - minuteOf(since) + 1)) : WINDOW_MINUTES;
  const buckets = await Promise.all(Array.from({ length: minutes }, (_, i) => redis.hgetall(`${base}:m:${now - i}`)));
  const [lat, lastOk, lastFail] = await Promise.all([redis.lrange(`${base}:lat`, 0, LATENCY_SAMPLES - 1), redis.get(`${base}:last_ok`), redis.get(`${base}:last_fail`)]);
  return computeMetrics(buckets, lat.map(Number), lastOk, lastFail);
}

/**
 * Circuit-breaker decision. Returns null when there's not enough traffic to judge (the caller keeps
 * the current status). DOWN providers get no routed traffic, so recovery relies on health probes,
 * which the worker records as samples.
 */
export function evaluateBreaker(m: HealthMetrics, policy: BreakerPolicy = DEFAULT_BREAKER): BreakerStatus | null {
  if (m.requests < policy.minSamples) return null;
  const errorRate = (m.failures + m.timeouts) / m.requests;
  if (errorRate >= policy.downErrorRate) return 'DOWN';
  if (errorRate >= policy.degradedErrorRate || (m.p95LatencyMs ?? 0) >= policy.degradedP95Ms) return 'DEGRADED';
  return 'ACTIVE';
}

/** Probe results (newest first) are kept separately from routed traffic. */
export async function recordProbe(redis: RedisLike, providerId: string, ok: boolean): Promise<void> {
  const tx = redis.multi();
  tx.lpush(`ph:${providerId}:probes`, ok ? '1' : '0');
  tx.ltrim(`ph:${providerId}:probes`, 0, 9);
  await tx.exec();
}

export async function readProbes(redis: RedisLike, providerId: string): Promise<boolean[]> {
  return (await redis.lrange(`ph:${providerId}:probes`, 0, 9)).map((v) => v === '1');
}

/**
 * Next automatic status. Combines the traffic-based breaker with half-open recovery: a DOWN
 * provider gets no routed traffic, so it recovers through consecutive successful probes
 * (DOWN → DEGRADED after 3 good probes; DEGRADED → ACTIVE once traffic or probes look healthy).
 * Consecutive failed probes take an otherwise idle provider DOWN.
 */
export function nextAutoStatus(current: BreakerStatus, metrics: HealthMetrics, probes: boolean[], policy: BreakerPolicy = DEFAULT_BREAKER): BreakerStatus {
  const recentOk = probes.length >= 3 && probes.slice(0, 3).every(Boolean);
  const recentFail = probes.length >= 3 && probes.slice(0, 3).every((p) => !p);
  const breaker = evaluateBreaker(metrics, policy);

  if (current === 'DOWN') return recentOk ? 'DEGRADED' : 'DOWN';
  if (recentFail) return 'DOWN';
  if (breaker) return breaker;
  if (current === 'DEGRADED' && recentOk) return 'ACTIVE';
  return current;
}
