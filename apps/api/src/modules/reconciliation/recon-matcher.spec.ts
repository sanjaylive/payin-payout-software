import { describe, expect, it } from 'vitest';
import { compare, parseStatement } from './recon-matcher';

describe('statement parser', () => {
  it('normalises columns, amounts, statuses and dates; flags bad rows', () => {
    const { rows, error } = parseStatement('Reference,Amount,Status,Date,UTR\npay_1,1000.00,Captured,2026-10-06,412345678901\npay_2,abc,failed,2026-10-06,\n,1.00,success,2026-10-06,');
    expect(error).toBeUndefined();
    expect(rows[0]).toMatchObject({ lineNo: 2, reference: 'pay_1', amountMinor: 100_000n, status: 'SUCCESS', utr: '412345678901' });
    expect(rows[0]!.date!.toISOString()).toBe('2026-10-05T18:30:00.000Z');
    expect(rows[1]).toMatchObject({ status: 'FAILED', error: 'Invalid amount' });
    expect(rows[2]!.error).toBe('Missing reference');
  });
  it('rejects files without the required columns', () => {
    expect(parseStatement('ref,amt\nx,1').error).toMatch(/reference/);
  });
});

describe('compare', () => {
  it('classifies status and amount differences', () => {
    expect(compare({ amountMinor: 100n, status: 'SUCCESS' }, { amountMinor: 100n, succeeded: true })).toBe('MATCHED');
    expect(compare({ amountMinor: 100n, status: 'FAILED' }, { amountMinor: 100n, succeeded: false })).toBe('MATCHED');
    expect(compare({ amountMinor: 90n, status: 'SUCCESS' }, { amountMinor: 100n, succeeded: true })).toBe('AMOUNT_MISMATCH');
    expect(compare({ amountMinor: 100n, status: 'SUCCESS' }, { amountMinor: 100n, succeeded: false })).toBe('STATUS_MISMATCH'); // provider paid, we gave up
    expect(compare({ amountMinor: 100n, status: 'FAILED' }, { amountMinor: 100n, succeeded: true })).toBe('STATUS_MISMATCH'); // we credited, provider says failed
    expect(compare({ amountMinor: 100n, status: 'REVERSED' }, { amountMinor: 100n, succeeded: true, reversed: true })).toBe('MATCHED');
    expect(compare({ amountMinor: 100n, status: 'REVERSED' }, { amountMinor: 100n, succeeded: true })).toBe('STATUS_MISMATCH');
  });
});
