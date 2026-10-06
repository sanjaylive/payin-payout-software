import { formatMinor } from '@pay2all/ui/lib/money';

/** API amounts are exact major-unit strings ("1234.50"); convert to paise without floats. */
export function majorToMinor(major: string): bigint {
  const [whole = '0', frac = ''] = major.replace('-', '').split('.');
  const minor = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return major.startsWith('-') ? -minor : minor;
}

export const fmt = (major: string | null | undefined) => (major === null || major === undefined ? '—' : formatMinor(majorToMinor(major)));

export const JOURNAL_LABELS: Record<string, string> = {
  PAYIN_CAPTURE: 'Payin captured',
  PROVIDER_SETTLEMENT: 'Provider settlement',
  SETTLEMENT: 'Settlement',
  HOLD_RELEASE: 'Hold released',
  REFUND: 'Refund',
  REFUND_REVERSAL: 'Refund reversed',
  CHARGEBACK_LIEN: 'Chargeback lien',
  CHARGEBACK_DEBIT: 'Chargeback debit',
  CHARGEBACK_RELEASE: 'Chargeback released',
  PAYOUT_RESERVE: 'Payout reserved',
  PAYOUT_SETTLE: 'Payout completed',
  PAYOUT_RELEASE: 'Payout released',
  PAYOUT_REVERSAL: 'Payout returned',
  ADJUSTMENT_CREDIT: 'Adjustment credit',
  ADJUSTMENT_DEBIT: 'Adjustment debit',
  LIEN_PLACE: 'Lien placed',
  LIEN_RELEASE: 'Lien released',
  COMMISSION_ACCRUAL: 'Commission accrued',
  PROVIDER_CHARGE: 'Provider charge',
  REVERSAL: 'Correction (reversal)',
};

export const BUCKET_LABELS: Record<string, string> = {
  AVAILABLE: 'Available',
  UNSETTLED: 'Unsettled',
  PENDING: 'Pending (on hold)',
  RESERVED: 'Reserved for payouts',
  LIEN: 'Lien',
  SETTLED: 'Settled to date',
  RECEIVABLE: 'Receivable',
};
