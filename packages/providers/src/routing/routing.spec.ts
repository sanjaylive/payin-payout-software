import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../interfaces/errors';
import { type Candidate, decideRoute, inTimeWindow, type ProviderInfo, type RouteRule, type RoutingRequest, smoothedConversion } from './engine';
import { executeWithFailover, FailoverStoppedError, NoProviderAvailableError } from './failover';

const p = (id: string, over: Partial<ProviderInfo> = {}): ProviderInfo => ({ id, code: id, kind: 'BOTH', status: 'ACTIVE', capabilities: {}, costs: {}, ...over });
const rule = (id: string, providerId: string, over: Partial<RouteRule> = {}): RouteRule => ({
  id, name: id, service: 'PAYOUT', tier: 'PRIMARY', priority: 100, isActive: true, providerId, merchantId: null, resellerId: null, method: null,
  minAmountMinor: null, maxAmountMinor: null, riskCategories: [], timeWindow: null, ...over,
});
const req = (over: Partial<RoutingRequest> = {}): RoutingRequest => ({ service: 'PAYOUT', merchantId: 'mA', resellerId: null, amountMinor: 100_000n, method: 'IMPS', riskCategory: 'LOW', at: new Date('2026-10-06T06:30:00Z'), ...over });
const codes = (cs: Candidate[]) => cs.map((c) => c.providerCode);

describe('routing engine (spec examples)', () => {
  it('routes per merchant: Merchant A → Provider 1, Merchant B → Provider 2', () => {
    const rules = [rule('a', 'p1', { merchantId: 'mA' }), rule('b', 'p2', { merchantId: 'mB' })];
    const providers = [p('p1'), p('p2')];
    expect(codes(decideRoute(rules, providers, req({ merchantId: 'mA' })).candidates)).toEqual(['p1']);
    expect(codes(decideRoute(rules, providers, req({ merchantId: 'mB' })).candidates)).toEqual(['p2']);
  });

  it('routes by amount slab: ₹0–₹5,000 → P1, ₹5,000.01+ → P2', () => {
    const rules = [rule('small', 'p1', { maxAmountMinor: 500_000n }), rule('large', 'p2', { minAmountMinor: 500_001n })];
    const providers = [p('p1'), p('p2')];
    expect(codes(decideRoute(rules, providers, req({ amountMinor: 500_000n })).candidates)).toEqual(['p1']);
    expect(codes(decideRoute(rules, providers, req({ amountMinor: 500_001n })).candidates)).toEqual(['p2']);
  });

  it('falls back to Provider 2 when Provider 1 is DOWN, and explains why', () => {
    const rules = [rule('primary', 'p1'), rule('fallback', 'p2', { tier: 'FALLBACK' })];
    const up = decideRoute(rules, [p('p1'), p('p2')], req());
    expect(codes(up.candidates)).toEqual(['p1', 'p2']);
    const down = decideRoute(rules, [p('p1', { status: 'DOWN' }), p('p2')], req());
    expect(codes(down.candidates)).toEqual(['p2']);
    expect(down.evaluations.find((e) => e.routeId === 'primary')).toMatchObject({ selected: false, reasons: ['provider down'] });
  });

  it('orders PRIMARY → SECONDARY → FALLBACK, healthy before degraded, specific before global', () => {
    const rules = [
      rule('global', 'p1', { priority: 1 }),
      rule('merchant', 'p2', { merchantId: 'mA', priority: 50 }),
      rule('degraded', 'p3', { priority: 0 }),
      rule('secondary', 'p4', { tier: 'SECONDARY' }),
    ];
    const d = decideRoute(rules, [p('p1'), p('p2'), p('p3', { status: 'DEGRADED' }), p('p4')], req());
    expect(codes(d.candidates)).toEqual(['p2', 'p1', 'p3', 'p4']);
  });

  it('breaks ties on success rate, then cost, then latency', () => {
    const rules = [rule('r1', 'p1'), rule('r2', 'p2'), rule('r3', 'p3')];
    const d = decideRoute(
      rules,
      [
        p('p1', { health: { successRate: 0.95, p95LatencyMs: 200 }, costs: { payout_flat_minor: 300 } }),
        p('p2', { health: { successRate: 0.99, p95LatencyMs: 900 }, costs: { payout_flat_minor: 500 } }),
        p('p3', { health: { successRate: 0.95, p95LatencyMs: 100 }, costs: { payout_flat_minor: 250 } }),
      ],
      req(),
    );
    expect(codes(d.candidates)).toEqual(['p2', 'p3', 'p1']);
  });

  it('honours provider capabilities, limits, kind, risk category and maintenance', () => {
    const rules = [rule('r1', 'p1'), rule('r2', 'p2'), rule('r3', 'p3'), rule('r4', 'p4', { riskCategories: ['HIGH'] }), rule('r5', 'p5')];
    const d = decideRoute(
      rules,
      [
        p('p1', { capabilities: { payout_modes: ['NEFT'] } }),
        p('p2', { capabilities: { max_amount_minor: '50000' } }),
        p('p3', { kind: 'PAYIN' }),
        p('p4'),
        p('p5', { status: 'MAINTENANCE' }),
      ],
      req(),
    );
    expect(d.candidates).toEqual([]);
    expect(d.evaluations.map((e) => e.reasons[0])).toEqual([
      'provider does not support IMPS',
      'amount above provider maximum',
      'provider does not support PAYOUT',
      'risk category not covered',
      'provider maintenance',
    ]);
  });

  it('lists each provider once even when several rules match', () => {
    const d = decideRoute([rule('a', 'p1'), rule('b', 'p1', { tier: 'FALLBACK' })], [p('p1')], req());
    expect(codes(d.candidates)).toEqual(['p1']);
  });

  it('evaluates IST time windows, including ones crossing midnight', () => {
    const night = { start: '22:00', end: '06:00' };
    expect(inTimeWindow(night, new Date('2026-10-06T17:00:00Z'))).toBe(true); // 22:30 IST
    expect(inTimeWindow(night, new Date('2026-10-06T00:00:00Z'))).toBe(true); // 05:30 IST
    expect(inTimeWindow(night, new Date('2026-10-06T06:30:00Z'))).toBe(false); // 12:00 IST
    expect(inTimeWindow({ start: '00:00', end: '23:59', days: [6, 7] }, new Date('2026-10-06T06:30:00Z'))).toBe(false); // Tuesday
  });
});

describe('failover executor', () => {
  const cands: Candidate[] = ['p1', 'p2', 'p3'].map((c) => ({ routeId: c, routeName: c, providerId: c, providerCode: c, tier: 'PRIMARY', priority: 1, degraded: false }));

  it('moves on only when nothing happened at the provider', async () => {
    const attempt = vi.fn(async (c: Candidate) => {
      if (c.providerCode === 'p1') throw new ProviderError('NOT_ATTEMPTED', 'ECONNREFUSED', 'down');
      if (c.providerCode === 'p2') throw new ProviderError('REJECTED', 'BANK_DOWN', 'rejected');
      return 'ok';
    });
    const out = await executeWithFailover(cands, attempt);
    expect(out.candidate.providerCode).toBe('p3');
    expect(out.attempts.map((a) => a.errorKind ?? 'OK')).toEqual(['NOT_ATTEMPTED', 'REJECTED', 'OK']);
  });

  it('STOPS on an ambiguous outcome — the next provider is never called (no duplicate transfer)', async () => {
    const attempt = vi.fn(async (c: Candidate) => {
      if (c.providerCode === 'p1') throw new ProviderError('AMBIGUOUS', 'TIMEOUT', 'timeout after send');
      return 'should never happen';
    });
    await expect(executeWithFailover(cands, attempt)).rejects.toBeInstanceOf(FailoverStoppedError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('treats unclassified errors as ambiguous', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(executeWithFailover(cands, attempt)).rejects.toBeInstanceOf(FailoverStoppedError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('reports exhaustion and handles no candidates', async () => {
    const refuse = async () => {
      throw new ProviderError('NOT_ATTEMPTED', 'X', 'x');
    };
    await expect(executeWithFailover(cands, refuse)).rejects.toBeInstanceOf(NoProviderAvailableError);
    await expect(executeWithFailover([], refuse)).rejects.toThrow(/No eligible provider/);
  });
});

describe('routing engine: SCORE strategy', () => {
  const rules = [rule('a', 'p1', { priority: 1 }), rule('b', 'p2', { tier: 'SECONDARY', priority: 1 }), rule('c', 'p3', { priority: 50 }), rule('f', 'p4', { tier: 'FALLBACK' })];
  const providers = [p('p1'), p('p2'), p('p3'), p('p4')];
  const conversion = new Map([['p1', 0.7], ['p2', 0.95], ['p3', 0.9], ['p4', 0.99]]);

  it('ranks PRIMARY and SECONDARY together by score; FALLBACK stays last whatever its score', () => {
    expect(codes(decideRoute(rules, providers, req()).candidates)).toEqual(['p1', 'p3', 'p2', 'p4']);
    const d = decideRoute(rules, providers, req(), { strategy: 'SCORE', conversion });
    expect(codes(d.candidates)).toEqual(['p2', 'p3', 'p1', 'p4']);
    expect(d.candidates.map((c) => c.score)).toEqual([0.95, 0.9, 0.7, 0.99]);
  });

  it('multiplies conversion by API health, keeps degraded providers behind healthy ones and pinned rules first', () => {
    const health = [p('p1'), p('p2', { health: { successRate: 0.5, p95LatencyMs: null } }), p('p3'), p('p4')];
    expect(codes(decideRoute(rules, health, req(), { strategy: 'SCORE', conversion }).candidates)).toEqual(['p3', 'p1', 'p2', 'p4']);
    const degraded = [p('p1'), p('p2', { status: 'DEGRADED' }), p('p3'), p('p4')];
    expect(codes(decideRoute(rules, degraded, req(), { strategy: 'SCORE', conversion }).candidates)).toEqual(['p3', 'p1', 'p2', 'p4']);
    const pinned = [...rules, rule('m', 'p1', { merchantId: 'mA' })];
    expect(codes(decideRoute(pinned, providers, req(), { strategy: 'SCORE', conversion }).candidates)[0]).toBe('p1');
  });

  it('explores: swaps the top two peers for a share of decisions, never promoting a fallback', () => {
    const d = decideRoute(rules, providers, req(), { strategy: 'SCORE', conversion, explore: 0.05, random: () => 0.01 });
    expect(codes(d.candidates)).toEqual(['p3', 'p2', 'p1', 'p4']);
    expect(d.candidates[0]).toMatchObject({ explored: true });
    expect(codes(decideRoute(rules, providers, req(), { strategy: 'SCORE', conversion, explore: 0.05, random: () => 0.5 }).candidates)[0]).toBe('p2');
    const onePlusFallback = [rule('a', 'p1'), rule('f', 'p4', { tier: 'FALLBACK' })];
    expect(codes(decideRoute(onePlusFallback, providers, req(), { strategy: 'SCORE', conversion, explore: 1, random: () => 0 }).candidates)).toEqual(['p1', 'p4']);
  });

  it('smooths conversion towards the prior when there is little data', () => {
    expect(smoothedConversion(1, 0, 0.8, 20)).toBeCloseTo(0.8095, 4);
    expect(smoothedConversion(900, 100, 0.8, 20)).toBeCloseTo(0.8980, 4);
    expect(smoothedConversion(0, 0, 0.8, 20)).toBe(0.8);
  });
});
