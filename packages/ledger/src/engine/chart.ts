import { isSupportedCurrency } from '../money';
import { LedgerValidationError } from './errors';
import type { AccountSpec, Bucket } from './types';

/**
 * Chart of accounts (docs/LEDGER.md §3). Account codes are structured, and the code alone fully
 * determines an account's type, normal side, ownership and whether its balance is maintained —
 * there is no way to create an account with inconsistent properties.
 */

const MERCHANT_BUCKETS: Record<Exclude<Bucket, 'COMMISSION_PAYABLE'>, { name: string; asset?: boolean }> = {
  PENDING: { name: 'Pending (on hold)' },
  UNSETTLED: { name: 'Unsettled' },
  AVAILABLE: { name: 'Available' },
  RESERVED: { name: 'Reserved for payouts' },
  LIEN: { name: 'Lien' },
  SETTLED: { name: 'Settled to date (memo)' },
  RECEIVABLE: { name: 'Receivable from merchant', asset: true },
};

const PLATFORM_FIXED: Record<string, Omit<AccountSpec, 'code' | 'currency' | 'ownerId' | 'ownerType' | 'bucket' | 'maintained' | 'allowNegative'>> = {
  'platform:FEE_REVENUE': { name: 'Fee revenue', type: 'REVENUE', normalBalance: 'CREDIT' },
  'platform:GST_PAYABLE': { name: 'GST payable', type: 'LIABILITY', normalBalance: 'CREDIT' },
  'platform:PROVIDER_COST': { name: 'Provider cost', type: 'EXPENSE', normalBalance: 'DEBIT' },
  'platform:COMMISSION_EXPENSE': { name: 'Reseller commission expense', type: 'EXPENSE', normalBalance: 'DEBIT' },
  'platform:ADJUSTMENT_SUSPENSE': { name: 'Adjustment suspense', type: 'CLEARING', normalBalance: 'DEBIT' },
  'platform:SUSPENSE': { name: 'Suspense (unidentified funds)', type: 'CLEARING', normalBalance: 'DEBIT' },
  'platform:memo:SETTLED_CONTRA': { name: 'Settled memo contra', type: 'CLEARING', normalBalance: 'DEBIT' },
};

const ID_PART = /^[a-z]{2,5}_[0-9A-Z]{26}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{1,40}$/;

export const Accounts = {
  merchant: (merchantId: string, bucket: Exclude<Bucket, 'COMMISSION_PAYABLE'>) => `merchant:${merchantId}:${bucket}`,
  resellerCommission: (resellerId: string) => `reseller:${resellerId}:COMMISSION_PAYABLE`,
  providerClearing: (providerCode: string) => `platform:provider:${providerCode}:CLEARING`,
  bank: (bankAccountRef: string) => `platform:bank:${bankAccountRef}`,
  FEE_REVENUE: 'platform:FEE_REVENUE',
  GST_PAYABLE: 'platform:GST_PAYABLE',
  PROVIDER_COST: 'platform:PROVIDER_COST',
  COMMISSION_EXPENSE: 'platform:COMMISSION_EXPENSE',
  ADJUSTMENT_SUSPENSE: 'platform:ADJUSTMENT_SUSPENSE',
  SUSPENSE: 'platform:SUSPENSE',
  SETTLED_CONTRA: 'platform:memo:SETTLED_CONTRA',
} as const;

export function accountSpec(code: string, currency: string): AccountSpec {
  if (!isSupportedCurrency(currency)) throw new LedgerValidationError(`Unsupported currency ${currency}`);
  const base = { code, currency };
  const parts = code.split(':');

  if (parts[0] === 'merchant' && parts.length === 3 && ID_PART.test(parts[1]!)) {
    const bucket = parts[2] as keyof typeof MERCHANT_BUCKETS;
    const def = MERCHANT_BUCKETS[bucket];
    if (!def) throw new LedgerValidationError(`Unknown merchant bucket in ${code}`);
    return {
      ...base,
      name: `${def.name}`,
      type: def.asset ? 'ASSET' : 'LIABILITY',
      normalBalance: def.asset ? 'DEBIT' : 'CREDIT',
      ownerType: 'MERCHANT',
      ownerId: parts[1]!,
      bucket,
      allowNegative: false,
      maintained: true,
    };
  }
  if (parts[0] === 'reseller' && parts.length === 3 && ID_PART.test(parts[1]!) && parts[2] === 'COMMISSION_PAYABLE') {
    return { ...base, name: 'Commission payable', type: 'LIABILITY', normalBalance: 'CREDIT', ownerType: 'RESELLER', ownerId: parts[1]!, bucket: 'COMMISSION_PAYABLE', allowNegative: false, maintained: true };
  }
  if (parts[0] === 'platform' && parts[1] === 'provider' && parts.length === 4 && SLUG.test(parts[2]!) && parts[3] === 'CLEARING') {
    return { ...base, name: `Provider clearing — ${parts[2]}`, type: 'CLEARING', normalBalance: 'DEBIT', ownerType: 'PLATFORM', ownerId: null, bucket: null, allowNegative: true, maintained: false };
  }
  if (parts[0] === 'platform' && parts[1] === 'bank' && parts.length === 3 && SLUG.test(parts[2]!)) {
    return { ...base, name: `Bank — ${parts[2]}`, type: 'ASSET', normalBalance: 'DEBIT', ownerType: 'PLATFORM', ownerId: null, bucket: null, allowNegative: true, maintained: false };
  }
  const fixed = PLATFORM_FIXED[code];
  if (fixed) return { ...base, ...fixed, ownerType: 'PLATFORM', ownerId: null, bucket: null, allowNegative: true, maintained: false };

  throw new LedgerValidationError(`Unknown ledger account code: ${code}`);
}
