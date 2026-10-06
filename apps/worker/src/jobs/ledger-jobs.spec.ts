import { describe, expect, it } from 'vitest';
import { istDate, istMidnightUtc } from './ledger-jobs';

describe('IST date helpers', () => {
  it('maps instants to IST calendar days', () => {
    expect(istDate(new Date('2026-10-06T18:29:59Z'))).toBe('2026-10-06'); // 23:59:59 IST
    expect(istDate(new Date('2026-10-06T18:30:00Z'))).toBe('2026-10-07'); // 00:00 IST next day
  });
  it('computes 00:00 IST in UTC', () => {
    expect(istMidnightUtc('2026-10-07').toISOString()).toBe('2026-10-06T18:30:00.000Z');
  });
});
