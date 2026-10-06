import { describe, expect, it } from 'vitest';
import { computeMetrics, evaluateBreaker, nextAutoStatus, readMetrics, recordProbe, readProbes, recordSample, type RedisLike } from './health';

class FakeRedis implements RedisLike {
  hashes = new Map<string, Record<string, string>>();
  lists = new Map<string, string[]>();
  strings = new Map<string, string>();
  multi() {
    const ops: (() => void)[] = [];
    const { hashes, lists, strings } = this;
    const chain = {
      hincrby(k: string, f: string, by: number) {
        ops.push(() => {
          const h = hashes.get(k) ?? {};
          h[f] = String(Number(h[f] ?? 0) + by);
          hashes.set(k, h);
        });
        return chain;
      },
      expire() {
        return chain;
      },
      lpush(k: string, v: string) {
        ops.push(() => lists.set(k, [v, ...(lists.get(k) ?? [])]));
        return chain;
      },
      ltrim(k: string, s: number, e: number) {
        ops.push(() => lists.set(k, (lists.get(k) ?? []).slice(s, e + 1)));
        return chain;
      },
      set(k: string, v: string) {
        ops.push(() => strings.set(k, v));
        return chain;
      },
      async exec() {
        ops.forEach((o) => o());
        return [];
      },
    };
    return chain;
  }
  async hgetall(k: string) {
    return this.hashes.get(k) ?? {};
  }
  async lrange(k: string, s: number, e: number) {
    return (this.lists.get(k) ?? []).slice(s, e + 1);
  }
  async get(k: string) {
    return this.strings.get(k) ?? null;
  }
}

describe('provider health', () => {
  it('records samples and computes rates and latency percentiles', async () => {
    const redis = new FakeRedis();
    const at = new Date('2026-10-06T10:00:30Z');
    for (let i = 1; i <= 100; i++) await recordSample(redis, 'prv_1', 'PAYOUT', i <= 90 ? 'SUCCESS' : i <= 95 ? 'FAILURE' : 'TIMEOUT', i * 10, at);
    const m = await readMetrics(redis, 'prv_1', 'PAYOUT', at);
    expect(m).toMatchObject({ requests: 100, successes: 90, failures: 5, timeouts: 5, successRate: 0.9, avgLatencyMs: 505, p95LatencyMs: 950, p99LatencyMs: 990 });
    expect(m.lastFailureAt?.toISOString()).toBe(at.toISOString());
  });

  it('trips the breaker on error rate and slow p95, but not on thin traffic', () => {
    const base = computeMetrics([], [], null, null);
    expect(evaluateBreaker({ ...base, requests: 5, failures: 5 })).toBeNull();
    expect(evaluateBreaker({ ...base, requests: 100, successes: 40, failures: 30, timeouts: 30 })).toBe('DOWN');
    expect(evaluateBreaker({ ...base, requests: 100, successes: 80, failures: 20 })).toBe('DEGRADED');
    expect(evaluateBreaker({ ...base, requests: 100, successes: 100, p95LatencyMs: 8000 })).toBe('DEGRADED');
    expect(evaluateBreaker({ ...base, requests: 100, successes: 99, failures: 1, p95LatencyMs: 300 })).toBe('ACTIVE');
  });

  it('recovers DOWN providers through probes (half-open) and takes silent dead ones down', async () => {
    const redis = new FakeRedis();
    const idle = computeMetrics([], [], null, null);
    expect(nextAutoStatus('DOWN', idle, await readProbes(redis, 'p'))).toBe('DOWN');
    for (let i = 0; i < 3; i++) await recordProbe(redis, 'p', true);
    expect(nextAutoStatus('DOWN', idle, await readProbes(redis, 'p'))).toBe('DEGRADED');
    expect(nextAutoStatus('DEGRADED', idle, await readProbes(redis, 'p'))).toBe('ACTIVE');
    for (let i = 0; i < 3; i++) await recordProbe(redis, 'p', false);
    expect(nextAutoStatus('ACTIVE', idle, await readProbes(redis, 'p'))).toBe('DOWN');
  });

  it('only counts traffic since the last status change', async () => {
    const redis = new FakeRedis();
    const old = new Date('2026-10-06T10:00:00Z');
    for (let i = 0; i < 30; i++) await recordSample(redis, 'p', 'PAYIN', 'FAILURE', 100, old);
    const now = new Date('2026-10-06T10:10:00Z');
    expect((await readMetrics(redis, 'p', 'PAYIN', now)).failures).toBe(30);
    expect((await readMetrics(redis, 'p', 'PAYIN', now, new Date('2026-10-06T10:08:00Z'))).failures).toBe(0);
  });
});
