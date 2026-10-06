/**
 * Indian business/KYC identifier validation. Format checks only — authenticity is verified with
 * registries/providers during compliance review.
 */

export const ENTITY_TYPES = [
  'PROPRIETORSHIP',
  'PARTNERSHIP',
  'LLP',
  'PRIVATE_LIMITED',
  'PUBLIC_LIMITED',
  'ONE_PERSON_COMPANY',
  'TRUST',
  'SOCIETY',
  'HUF',
  'GOVERNMENT',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** The 4th PAN character encodes the holder type (P individual, C company, F firm/LLP, T trust …). */
const PAN_HOLDER_BY_ENTITY: Record<EntityType, string[]> = {
  PROPRIETORSHIP: ['P'], // proprietor's personal PAN
  PARTNERSHIP: ['F'],
  LLP: ['F'],
  PRIVATE_LIMITED: ['C'],
  PUBLIC_LIMITED: ['C'],
  ONE_PERSON_COMPANY: ['C'],
  TRUST: ['T'],
  SOCIETY: ['A', 'T'],
  HUF: ['H'],
  GOVERNMENT: ['G'],
};

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
export const LLPIN_RE = /^[A-Z]{3}-[0-9]{4}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const DIN_RE = /^[0-9]{8}$/;
export const PINCODE_RE = /^[1-9][0-9]{5}$/;
export const MCC_RE = /^[0-9]{4}$/;
export const BANK_ACCOUNT_RE = /^[0-9]{9,18}$/;

export function panMatchesEntity(pan: string, entity: EntityType): boolean {
  return PAN_HOLDER_BY_ENTITY[entity].includes(pan.charAt(3));
}

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check character (15th) per the GSTN mod-36 algorithm. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GST_CHARS.indexOf(first14.charAt(i));
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GST_CHARS.charAt((36 - (sum % 36)) % 36);
}

export function isValidGstin(gstin: string): boolean {
  return GSTIN_RE.test(gstin) && gstinCheckChar(gstin.slice(0, 14)) === gstin.charAt(14);
}

/** PAN embedded in a GSTIN (characters 3–12). */
export function panFromGstin(gstin: string): string {
  return gstin.slice(2, 12);
}

/** Mask all but the last 4 characters: XXXXXX1234. */
export function maskTail(value: string, visible = 4): string {
  return `${'X'.repeat(Math.max(0, value.length - visible))}${value.slice(-visible)}`;
}
