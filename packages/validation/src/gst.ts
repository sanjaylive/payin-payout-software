import { z } from 'zod';
import { idSchema, paginationQuerySchema } from './common';
import { gstinSchema } from './merchant';

/** GST tax invoices for platform fees (docs/INVOICES.md). */

/** GST state / UT codes (first two digits of a GSTIN). */
export const GST_STATES: readonly { code: string; name: string }[] = [
  { code: '01', name: 'Jammu and Kashmir' }, { code: '02', name: 'Himachal Pradesh' }, { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' }, { code: '05', name: 'Uttarakhand' }, { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' }, { code: '08', name: 'Rajasthan' }, { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' }, { code: '11', name: 'Sikkim' }, { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' }, { code: '14', name: 'Manipur' }, { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' }, { code: '17', name: 'Meghalaya' }, { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' }, { code: '20', name: 'Jharkhand' }, { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' }, { code: '23', name: 'Madhya Pradesh' }, { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' }, { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' }, { code: '30', name: 'Goa' }, { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' }, { code: '33', name: 'Tamil Nadu' }, { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' }, { code: '36', name: 'Telangana' }, { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const ALIASES: Record<string, string> = { orissa: '21', pondicherry: '34', newdelhi: '07', nctofdelhi: '07', jk: '01', up: '09', mp: '23', tn: '33', ap: '37', wb: '19' };

/** State code from a GSTIN (its first two digits) or a state name; null when unknown. */
export function gstStateCode(gstin?: string | null, stateName?: string | null): string | null {
  if (gstin && /^\d{2}[A-Z0-9]{13}$/.test(gstin) && GST_STATES.some((s) => s.code === gstin.slice(0, 2))) return gstin.slice(0, 2);
  if (!stateName) return null;
  const n = norm(stateName);
  return GST_STATES.find((s) => norm(s.name) === n)?.code ?? ALIASES[n] ?? null;
}

export const gstStateName = (code: string | null) => GST_STATES.find((s) => s.code === code)?.name ?? null;

/** Indian financial year (April–March) of an IST date: "2026-27". */
export function financialYear(d: Date): string {
  const ist = new Date(d.getTime() + 19_800_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** GST rule 46: at most 16 characters, unique per financial year: PREFIX + YYYY (FY) + '-' + serial. */
export function invoiceNumber(prefix: string, fy: string, serial: number): string {
  const fyShort = `${fy.slice(2, 4)}${fy.slice(5, 7)}`; // 2026-27 → 2627
  const n = `${prefix}${fyShort}-${String(serial).padStart(6, '0')}`;
  if (n.length > 16) throw new Error(`Invoice number ${n} is longer than 16 characters`);
  return n;
}

export const taxProfileSchema = z.strictObject({
  legal_name: z.string().trim().min(3).max(200),
  gstin: gstinSchema,
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Enter a valid PAN'),
  address: z.string().trim().min(10).max(400),
  state_code: z.string().regex(/^\d{2}$/).refine((c) => GST_STATES.some((s) => s.code === c), 'Unknown state code'),
  /** Services Accounting Code printed on invoices (financial services). */
  sac: z.string().trim().regex(/^\d{4,8}$/, 'SAC is 4–8 digits').default('997159'),
  /** 2–5 characters; the full number is PREFIX + FY + serial (≤ 16 characters). */
  invoice_prefix: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,4}$/, '2–5 letters or digits starting with a letter, e.g. P2A'),
  /** Optional footer, e.g. the bank account for payment of dues. */
  footer_note: z.string().trim().max(500).optional(),
  reason: z.string().trim().min(5).max(300),
}).refine((v) => v.gstin.slice(0, 2) === v.state_code, { path: ['state_code'], message: 'Must match the GSTIN’s state (its first two digits)' });

export const generateInvoicesSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month as YYYY-MM'),
  merchant_id: idSchema('org').optional(),
});

export const listInvoicesQuerySchema = paginationQuerySchema.extend({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  merchant_id: idSchema('org').optional(),
});

export const invoiceIdSchema = idSchema('inv');
