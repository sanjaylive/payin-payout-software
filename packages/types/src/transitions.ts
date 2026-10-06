/**
 * Transaction state machines (docs/PAYIN_FLOW.md §7). The single source of truth for allowed status
 * changes; services apply them with conditional updates (`WHERE status = ANY(from) AND version = v`).
 */

export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'SUCCESS',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'SETTLEMENT_PENDING',
  'SETTLED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DISPUTED',
  'CHARGEBACK',
] as const;
export type PaymentStatusValue = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_TRANSITIONS: Record<PaymentStatusValue, readonly PaymentStatusValue[]> = {
  CREATED: ['PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED'],
  PENDING: ['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED'],
  // Late success (policy-gated): the customer may have paid after we gave up.
  FAILED: ['SUCCESS'],
  EXPIRED: ['SUCCESS'],
  CANCELLED: ['SUCCESS'],
  SUCCESS: ['SETTLEMENT_PENDING', 'REFUND_PENDING', 'DISPUTED'],
  // Back to SUCCESS only when the bank settlement fails (funds returned to UNSETTLED; re-settled later).
  SETTLEMENT_PENDING: ['SETTLED', 'SUCCESS', 'REFUND_PENDING', 'DISPUTED'],
  SETTLED: ['REFUND_PENDING', 'DISPUTED'],
  REFUND_PENDING: ['SUCCESS', 'SETTLED', 'SETTLEMENT_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUND_PENDING', 'REFUNDED', 'DISPUTED'],
  REFUNDED: ['DISPUTED'],
  DISPUTED: ['CHARGEBACK', 'SUCCESS', 'SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  CHARGEBACK: [],
};

export function paymentCanTransition(from: PaymentStatusValue, to: PaymentStatusValue): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Statuses from which `to` is reachable — used to build conditional updates. */
export function paymentSourcesFor(to: PaymentStatusValue): PaymentStatusValue[] {
  return PAYMENT_STATUSES.filter((s) => PAYMENT_TRANSITIONS[s].includes(to));
}

export const PAYMENT_OPEN_STATUSES: readonly PaymentStatusValue[] = ['CREATED', 'PENDING'];
/** Statuses in which money has been captured (refundable, settleable). */
export const PAYMENT_CAPTURED_STATUSES: readonly PaymentStatusValue[] = ['SUCCESS', 'SETTLEMENT_PENDING', 'SETTLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED'];

export const REFUND_STATUSES = ['CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW'] as const;
export type RefundStatusValue = (typeof REFUND_STATUSES)[number];

export const REFUND_TRANSITIONS: Record<RefundStatusValue, readonly RefundStatusValue[]> = {
  CREATED: ['PENDING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW'],
  PENDING: ['SUCCESS', 'FAILED', 'MANUAL_REVIEW'],
  MANUAL_REVIEW: ['SUCCESS', 'FAILED'],
  SUCCESS: [],
  FAILED: [],
};

// ---- Payouts (docs/PAYOUT_FLOW.md §10) ------------------------------------------------------------

export const PAYOUT_STATUSES = [
  'CREATED', 'VALIDATING', 'APPROVAL_PENDING', 'MANUAL_REVIEW', 'QUEUED', 'PROCESSING', 'PENDING', 'SUCCESS', 'FAILED', 'REJECTED', 'REVERSED',
] as const;
export type PayoutStatusValue = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_TRANSITIONS: Record<PayoutStatusValue, readonly PayoutStatusValue[]> = {
  CREATED: ['VALIDATING', 'APPROVAL_PENDING', 'QUEUED', 'FAILED'],
  VALIDATING: ['APPROVAL_PENDING', 'QUEUED', 'MANUAL_REVIEW', 'FAILED'],
  APPROVAL_PENDING: ['QUEUED', 'REJECTED'],
  // Pre-send risk review, or post-send unknown outcome (resolved only with evidence + audit reason).
  MANUAL_REVIEW: ['QUEUED', 'REJECTED', 'SUCCESS', 'FAILED'],
  QUEUED: ['PROCESSING', 'REJECTED'],
  // PROCESSING → QUEUED only when every attempt provably never reached a provider (requeue).
  PROCESSING: ['QUEUED', 'PENDING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW'],
  PENDING: ['SUCCESS', 'FAILED', 'MANUAL_REVIEW'],
  SUCCESS: ['REVERSED'],
  FAILED: [],
  REJECTED: [],
  REVERSED: [],
};

export function payoutCanTransition(from: PayoutStatusValue, to: PayoutStatusValue): boolean {
  return PAYOUT_TRANSITIONS[from].includes(to);
}

/** Funds are held in RESERVED while a payout is in one of these. */
export const PAYOUT_RESERVED_STATUSES: readonly PayoutStatusValue[] = ['APPROVAL_PENDING', 'MANUAL_REVIEW', 'QUEUED', 'PROCESSING', 'PENDING'];
export const PAYOUT_TERMINAL_STATUSES: readonly PayoutStatusValue[] = ['SUCCESS', 'FAILED', 'REJECTED', 'REVERSED'];
