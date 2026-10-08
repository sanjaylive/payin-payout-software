import { LedgerValidationError } from './errors';
import type { AccountSpec, Bucket, JournalType, PostingLine } from './types';

/**
 * Structural rules per journal type: which merchant buckets a type may touch and in which direction.
 * They stop a coding mistake (e.g. a "reserve" that drains UNSETTLED) from ever reaching the database.
 */

type Leg = { bucket: Bucket; direction: 'DEBIT' | 'CREDIT' };
interface Rule {
  /** Merchant-side legs that must ALL be present (exact set). */
  exactMerchantLegs?: Leg[];
  /** Merchant-side legs that are allowed (subset). */
  allowedMerchantLegs?: Leg[];
  /** Platform accounts allowed in this journal (code prefixes). */
  allowedPlatform?: string[];
}

const D = (bucket: Bucket): Leg => ({ bucket, direction: 'DEBIT' });
const C = (bucket: Bucket): Leg => ({ bucket, direction: 'CREDIT' });

const RULES: Partial<Record<JournalType, Rule>> = {
  PAYIN_CAPTURE: { allowedMerchantLegs: [C('UNSETTLED'), C('PENDING')], allowedPlatform: ['platform:provider:', 'platform:FEE_REVENUE', 'platform:GST_PAYABLE', 'platform:MERCHANT_COMMISSION'] },
  HOLD_RELEASE: { exactMerchantLegs: [D('PENDING'), C('UNSETTLED')], allowedPlatform: [] },
  SETTLEMENT: { allowedMerchantLegs: [D('UNSETTLED'), C('AVAILABLE'), C('SETTLED')], allowedPlatform: ['platform:bank:', 'platform:memo:SETTLED_CONTRA'] },
  // Bank settlement: out of UNSETTLED into transit at creation; to the bank (+ SETTLED memo) once paid;
  // back to UNSETTLED if the transfer fails.
  SETTLEMENT_TRANSFER: { exactMerchantLegs: [D('UNSETTLED')], allowedPlatform: ['platform:SETTLEMENT_CLEARING'] },
  SETTLEMENT_PAID: { exactMerchantLegs: [C('SETTLED')], allowedPlatform: ['platform:SETTLEMENT_CLEARING', 'platform:bank:', 'platform:memo:SETTLED_CONTRA'] },
  SETTLEMENT_RETURN: { exactMerchantLegs: [C('UNSETTLED')], allowedPlatform: ['platform:SETTLEMENT_CLEARING'] },
  PAYOUT_RESERVE: { exactMerchantLegs: [D('AVAILABLE'), C('RESERVED')], allowedPlatform: [] },
  PAYOUT_SETTLE: { exactMerchantLegs: [D('RESERVED')], allowedPlatform: ['platform:provider:', 'platform:FEE_REVENUE', 'platform:GST_PAYABLE', 'platform:MERCHANT_COMMISSION'] },
  PAYOUT_RELEASE: { exactMerchantLegs: [D('RESERVED'), C('AVAILABLE')], allowedPlatform: [] },
  PAYOUT_REVERSAL: { allowedMerchantLegs: [C('AVAILABLE')], allowedPlatform: ['platform:provider:', 'platform:FEE_REVENUE', 'platform:GST_PAYABLE', 'platform:MERCHANT_COMMISSION'] },
  LIEN_PLACE: { allowedMerchantLegs: [D('AVAILABLE'), D('UNSETTLED'), C('LIEN')], allowedPlatform: [] },
  LIEN_RELEASE: { exactMerchantLegs: [D('LIEN'), C('AVAILABLE')], allowedPlatform: [] },
  // Wallet top-up: money received in a platform collection account, credited to the merchant.
  FUND_LOAD: { exactMerchantLegs: [C('AVAILABLE')], allowedPlatform: ['platform:bank:'] },
  ADJUSTMENT_CREDIT: { exactMerchantLegs: [C('AVAILABLE')], allowedPlatform: ['platform:ADJUSTMENT_SUSPENSE'] },
  ADJUSTMENT_DEBIT: { exactMerchantLegs: [D('AVAILABLE')], allowedPlatform: ['platform:ADJUSTMENT_SUSPENSE'] },
  // A refund also takes back the payment's share of scheme commission.
  REFUND: { allowedMerchantLegs: [D('UNSETTLED'), D('AVAILABLE')], allowedPlatform: ['platform:provider:', 'platform:MERCHANT_COMMISSION'] },
  REFUND_REVERSAL: { allowedMerchantLegs: [C('UNSETTLED'), C('AVAILABLE')], allowedPlatform: ['platform:provider:', 'platform:MERCHANT_COMMISSION'] },
  CHARGEBACK_LIEN: { allowedMerchantLegs: [D('AVAILABLE'), D('UNSETTLED'), D('RECEIVABLE'), C('LIEN')], allowedPlatform: [] },
  CHARGEBACK_DEBIT: { allowedMerchantLegs: [D('LIEN'), D('AVAILABLE'), D('RECEIVABLE')], allowedPlatform: ['platform:provider:', 'platform:FEE_REVENUE', 'platform:GST_PAYABLE'] },
  CHARGEBACK_RELEASE: { exactMerchantLegs: [D('LIEN'), C('AVAILABLE')], allowedPlatform: [] },
  PROVIDER_SETTLEMENT: { allowedMerchantLegs: [], allowedPlatform: ['platform:bank:', 'platform:PROVIDER_COST', 'platform:provider:'] },
  PROVIDER_CHARGE: { allowedMerchantLegs: [], allowedPlatform: ['platform:PROVIDER_COST', 'platform:provider:'] },
  COMMISSION_ACCRUAL: { allowedMerchantLegs: [], allowedPlatform: ['platform:COMMISSION_EXPENSE'] },
  COMMISSION_PAYOUT: { allowedMerchantLegs: [], allowedPlatform: ['platform:bank:'] },
  // REVERSAL mirrors an already-validated journal; only the single-merchant invariant applies.
};

const key = (l: Leg) => `${l.direction}:${l.bucket}`;

export function assertJournalRules(type: JournalType, lines: PostingLine[], specs: Map<string, AccountSpec>): void {
  const merchantIds = new Set<string>();
  const merchantLegs: Leg[] = [];
  for (const line of lines) {
    const spec = specs.get(line.accountCode)!;
    if (spec.ownerType === 'MERCHANT') {
      merchantIds.add(spec.ownerId!);
      merchantLegs.push({ bucket: spec.bucket!, direction: line.direction });
    }
  }
  // Universal invariant: a journal never moves value between two merchants.
  if (merchantIds.size > 1) throw new LedgerValidationError(`${type} journal touches more than one merchant`);

  const rule = RULES[type];
  if (!rule) return;
  const present = new Set(merchantLegs.map(key));
  if (rule.exactMerchantLegs) {
    const expected = new Set(rule.exactMerchantLegs.map(key));
    const same = present.size === expected.size && [...expected].every((k) => present.has(k));
    if (!same) throw new LedgerValidationError(`${type} must move exactly ${[...expected].join(', ')} on the merchant side`);
  }
  if (rule.allowedMerchantLegs) {
    const allowed = new Set(rule.allowedMerchantLegs.map(key));
    const bad = [...present].filter((k) => !allowed.has(k));
    if (bad.length) throw new LedgerValidationError(`${type} may not use ${bad.join(', ')}`);
  }
  if (rule.allowedPlatform) {
    for (const line of lines) {
      const spec = specs.get(line.accountCode)!;
      if (spec.ownerType === 'PLATFORM' && !rule.allowedPlatform.some((p) => line.accountCode.startsWith(p))) {
        throw new LedgerValidationError(`${type} may not post to ${line.accountCode}`);
      }
      if (spec.ownerType === 'RESELLER' && type !== 'COMMISSION_ACCRUAL' && type !== 'COMMISSION_PAYOUT') {
        throw new LedgerValidationError(`${type} may not post to reseller accounts`);
      }
      // Accruals only ever credit a reseller's payable; payouts only ever debit it.
      if (spec.ownerType === 'RESELLER' && line.direction !== (type === 'COMMISSION_ACCRUAL' ? 'CREDIT' : 'DEBIT')) {
        throw new LedgerValidationError(`${type} must ${type === 'COMMISSION_ACCRUAL' ? 'credit' : 'debit'} the reseller's commission payable`);
      }
    }
  }
}
