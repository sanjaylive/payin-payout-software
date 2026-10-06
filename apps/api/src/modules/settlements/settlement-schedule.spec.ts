import { describe, expect, it } from 'vitest';
import { cutoffInstant, istDate, settlementWindow } from './settlement-schedule';

describe('settlement schedule (IST)', () => {
  it('computes IST dates and cutoffs across the UTC day boundary', () => {
    expect(istDate(new Date('2026-10-06T19:00:00Z'))).toBe('2026-10-07'); // 00:30 IST next day
    expect(cutoffInstant('2026-10-07', 18 * 60).toISOString()).toBe('2026-10-07T12:30:00.000Z');
  });

  it('is due only after the cutoff, and covers captures before the cutoff N days earlier', () => {
    const cfg = { cycle: 'T1' as const, customDays: null, cutoffMinute: 18 * 60 };
    expect(settlementWindow(new Date('2026-10-07T12:00:00Z'), cfg).due).toBe(false); // 17:30 IST
    const w = settlementWindow(new Date('2026-10-07T13:00:00Z'), cfg); // 18:30 IST
    expect(w).toMatchObject({ settlementDate: '2026-10-07', due: true });
    expect(w.periodEnd.toISOString()).toBe('2026-10-06T12:30:00.000Z'); // yesterday 18:00 IST
    expect(settlementWindow(new Date('2026-10-07T13:00:00Z'), { ...cfg, cycle: 'T0' }).periodEnd.toISOString()).toBe('2026-10-07T12:30:00.000Z');
    expect(settlementWindow(new Date('2026-10-07T13:00:00Z'), { ...cfg, cycle: 'CUSTOM', customDays: 5 }).periodEnd.toISOString()).toBe('2026-10-02T12:30:00.000Z');
  });
});
