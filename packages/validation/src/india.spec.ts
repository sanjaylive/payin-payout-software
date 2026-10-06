import { describe, expect, it } from 'vitest';
import { gstinCheckChar, isValidGstin, maskTail, panFromGstin, panMatchesEntity } from './india';

describe('GSTIN', () => {
  it('accepts published sample GSTINs (checksum verified)', () => {
    // Examples published in GSTN/CBIC material and widely used as test vectors.
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('29AAGCB7383J1Z4')).toBe(true);
  });

  it('rejects a wrong check character or bad format', () => {
    expect(isValidGstin('27AAPFU0939F1ZW')).toBe(false);
    expect(isValidGstin('27aapfu0939f1zv')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
  });

  it('extracts the embedded PAN and computes check chars deterministically', () => {
    expect(panFromGstin('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
  });
});

describe('PAN', () => {
  it('matches holder type to entity type', () => {
    expect(panMatchesEntity('AAPFU0939F', 'PARTNERSHIP')).toBe(true);
    expect(panMatchesEntity('AAPFU0939F', 'PRIVATE_LIMITED')).toBe(false);
    expect(panMatchesEntity('ABCPE1234F', 'PROPRIETORSHIP')).toBe(true);
  });
});

it('masks values', () => {
  expect(maskTail('123456789012')).toBe('XXXXXXXX9012');
});
