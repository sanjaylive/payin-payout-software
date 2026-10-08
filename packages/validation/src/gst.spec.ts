import { describe, expect, it } from 'vitest';
import { financialYear, gstStateCode, invoiceNumber, taxProfileSchema } from './gst';

describe('GST helpers', () => {
  it('reads the state from a GSTIN or a state name', () => {
    expect(gstStateCode('27AABCP1234C1Z5')).toBe('27');
    expect(gstStateCode(null, 'Maharashtra')).toBe('27');
    expect(gstStateCode(null, ' tamil nadu ')).toBe('33');
    expect(gstStateCode(null, 'Orissa')).toBe('21');
    expect(gstStateCode('99AABCP1234C1Z5', 'Karnataka')).toBe('29');
    expect(gstStateCode(null, 'Atlantis')).toBeNull();
  });

  it('uses the Indian financial year in IST', () => {
    expect(financialYear(new Date('2026-03-31T18:29:00Z'))).toBe('2025-26'); // 31 Mar 23:59 IST
    expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toBe('2026-27'); // 1 Apr 00:01 IST
    expect(financialYear(new Date('2027-01-15T00:00:00Z'))).toBe('2026-27');
  });

  it('numbers invoices within 16 characters', () => {
    expect(invoiceNumber('P2A', '2026-27', 42)).toBe('P2A2627-000042');
    expect(invoiceNumber('PAYAL', '2026-27', 999999)).toHaveLength(16);
    expect(() => invoiceNumber('PAYAL', '2026-27', 1_000_000)).toThrow(/16/);
  });

  it('requires the state code to match the GSTIN', () => {
    const base = { legal_name: 'Pay Services Pvt Ltd', gstin: '27AABCP1234C1Z0', pan: 'AABCP1234C', address: '12 MG Road, Pune 411001', invoice_prefix: 'p2a', reason: 'Initial setup' };
    expect(taxProfileSchema.safeParse({ ...base, state_code: '27' }).success).toBe(true);
    expect(taxProfileSchema.safeParse({ ...base, state_code: '29' }).success).toBe(false);
  });
});
