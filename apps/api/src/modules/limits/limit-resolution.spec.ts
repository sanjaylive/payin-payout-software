import { describe, expect, it } from 'vitest';
import { approvalsRequired, isLooserPolicy, loosenedFields, resolveLimits } from './limit-resolution';

describe('limit resolution', () => {
  const system = { level: 'SYSTEM' as const, values: { perTxnMinMinor: 100n, perTxnMaxMinor: 10_000_000n, dailyAmountMinor: 100_000_000n } };
  const reseller = { level: 'RESELLER' as const, values: { perTxnMaxMinor: 5_000_000n } };
  const merchant = { level: 'MERCHANT' as const, values: { dailyAmountMinor: 20_000_000n, dailyCount: 500 } };

  it('resolves field by field, most specific first', () => {
    const r = resolveLimits([merchant, reseller, system]);
    expect(r.perTxnMinMinor).toEqual({ value: 100n, source: 'SYSTEM' });
    expect(r.perTxnMaxMinor).toEqual({ value: 5_000_000n, source: 'RESELLER' });
    expect(r.dailyAmountMinor).toEqual({ value: 20_000_000n, source: 'MERCHANT' });
    expect(r.dailyCount).toEqual({ value: 500, source: 'MERCHANT' });
    expect(r.monthlyCount).toEqual({ value: null, source: null });
  });

  it('detects attempts to loosen parent limits', () => {
    const parent = resolveLimits([reseller, system]);
    expect(loosenedFields({ perTxnMaxMinor: 6_000_000n }, parent)).toEqual(['perTxnMaxMinor']);
    expect(loosenedFields({ perTxnMinMinor: 50n }, parent)).toEqual(['perTxnMinMinor']);
    expect(loosenedFields({ perTxnMaxMinor: 1_000_000n, perTxnMinMinor: 500n }, parent)).toEqual([]);
  });
});

describe('approval policies', () => {
  // Spec: up to ₹10,000 auto; up to ₹1,00,000 one approver; above two approvers.
  const system = {
    makerCheckerEnabled: true,
    tiers: [
      { upToMinor: 1_000_000n, approvalsRequired: 0 },
      { upToMinor: 10_000_000n, approvalsRequired: 1 },
      { upToMinor: null, approvalsRequired: 2 },
    ],
  };

  it('maps amounts to tiers inclusively', () => {
    expect(approvalsRequired(system, 1_000_000n)).toBe(0); // ₹10,000.00
    expect(approvalsRequired(system, 1_000_001n)).toBe(1); // ₹10,000.01
    expect(approvalsRequired(system, 10_000_000n)).toBe(1); // ₹1,00,000.00
    expect(approvalsRequired(system, 10_000_001n)).toBe(2);
    expect(approvalsRequired({ ...system, makerCheckerEnabled: false }, 99_999_999n)).toBe(0);
  });

  it('flags child policies that are looser anywhere', () => {
    const stricter = { makerCheckerEnabled: true, tiers: [{ upToMinor: 500_000n, approvalsRequired: 0 }, { upToMinor: null, approvalsRequired: 2 }] };
    expect(isLooserPolicy(stricter, system)).toBe(false);
    const looser = { makerCheckerEnabled: true, tiers: [{ upToMinor: 5_000_000n, approvalsRequired: 0 }, { upToMinor: null, approvalsRequired: 2 }] };
    expect(isLooserPolicy(looser, system)).toBe(true);
    expect(isLooserPolicy({ ...system, makerCheckerEnabled: false }, system)).toBe(true);
  });
});
