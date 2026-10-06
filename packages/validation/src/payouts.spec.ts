import { describe, expect, it } from 'vitest';
import { bulkRowSchema, createPayoutSchema, modeViolation, nameMatchScore, parseCsv } from './payouts';

const base = { merchant_order_id: 'PO-1', amount: '15000.00', mode: 'IMPS', beneficiary: { name: 'ABC Vendor', account_number: '50100123457890', ifsc: 'hdfc0001234' } };

describe('createPayoutSchema', () => {
  it('parses rupee strings into paise and rejects JSON numbers', () => {
    expect(createPayoutSchema.parse(base).amount).toBe(1_500_000n);
    expect(createPayoutSchema.safeParse({ ...base, amount: 15000 }).success).toBe(false);
  });

  it('enforces mode rules', () => {
    expect(createPayoutSchema.safeParse({ ...base, mode: 'RTGS' }).success).toBe(false); // < ₹2,00,000
    expect(createPayoutSchema.safeParse({ ...base, mode: 'RTGS', amount: '200000.00' }).success).toBe(true);
    expect(createPayoutSchema.safeParse({ ...base, amount: '500000.01' }).success).toBe(false); // IMPS max
    expect(createPayoutSchema.safeParse({ ...base, mode: 'UPI' }).success).toBe(false); // needs upi_id
    expect(createPayoutSchema.safeParse({ ...base, mode: 'UPI', beneficiary: { name: 'Asha', upi_id: 'Asha@okbank' } }).success).toBe(true);
    expect(modeViolation('UPI', 10_000_001n)).toMatch(/at most/);
  });

  it('requires exactly one destination', () => {
    expect(createPayoutSchema.safeParse({ ...base, beneficiary: { name: 'X Y', account_number: '50100123457890', ifsc: 'HDFC0001234', upi_id: 'x@ok' } }).success).toBe(false);
    expect(createPayoutSchema.safeParse({ ...base, beneficiary: { beneficiary_id: 'ben_01JA9C2D4F6G8H0J2K4M6N8P0Q' } }).success).toBe(true);
  });
});

describe('nameMatchScore', () => {
  it('scores equivalent names highly and different people low', () => {
    expect(nameMatchScore('Rohit Sharma', 'SHARMA ROHIT')).toBe(100);
    expect(nameMatchScore('Mr. Rohit Sharma', 'ROHIT SHARMA')).toBe(100);
    expect(nameMatchScore('R Sharma', 'ROHIT SHARMA')).toBeGreaterThanOrEqual(80);
    expect(nameMatchScore('ABC Traders Pvt Ltd', 'M/S ABC TRADERS PRIVATE LIMITED')).toBe(100);
    expect(nameMatchScore('Rohit Sharma', 'PRIYA VERMA')).toBe(0);
  });
});

describe('bulk CSV', () => {
  it('parses quotes, escaped quotes, CRLF and blank lines', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });

  it('validates a row with mode rules', () => {
    const row = { merchant_order_id: 'B-1', amount: '100.00', mode: 'imps', beneficiary_name: 'Asha K', account_number: '123456789', ifsc: 'sbin0001234', upi_id: '', purpose: '', narration: '' };
    expect(bulkRowSchema.parse(row).mode).toBe('IMPS');
    expect(bulkRowSchema.safeParse({ ...row, account_number: '' }).success).toBe(false);
  });
});
