import type { Payment, PaymentAttempt, Refund } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';

const major = (v: bigint) => minorToMajorString(v);

export function maskVpa(vpa: string | null): string | null {
  if (!vpa) return null;
  const [user = '', handle = ''] = vpa.split('@');
  return `${user.slice(0, 2)}***@${handle}`;
}

const maskMobile = (m: string | null) => (m ? `${m.slice(0, 3)}******${m.slice(-4)}` : null);

export function presentRefund(r: Refund) {
  return {
    refund_id: r.id,
    payment_id: r.paymentId,
    merchant_refund_id: r.merchantRefundId,
    amount: major(r.amountMinor),
    currency: r.currency,
    status: r.status,
    reason: r.reason,
    failure_reason: r.failureReason,
    created_at: r.createdAt,
    completed_at: r.completedAt,
  };
}

export interface PresentOptions {
  /** Platform staff see provider routing details. */
  internal?: boolean;
  /** List views mask payer details. */
  list?: boolean;
  providerCode?: string | null;
  refunds?: Refund[];
  attempts?: (PaymentAttempt & { providerCode?: string })[];
}

export function presentPayment(p: Payment, opts: PresentOptions = {}) {
  return {
    payment_id: p.id,
    merchant_id: p.merchantId,
    merchant_order_id: p.merchantOrderId,
    checkout_session_id: p.checkoutSessionId,
    static_qr_id: p.staticQrId,
    amount: major(p.amountMinor),
    currency: p.currency,
    fee: major(p.feeMinor),
    commission: major(p.commissionMinor),
    tax: major(p.taxMinor),
    net_amount: major(p.netAmountMinor),
    refunded_amount: major(p.refundedAmountMinor),
    status: p.status,
    method: p.method,
    qr: opts.list ? undefined : p.qrPayload,
    upi_intent: opts.list ? undefined : p.upiIntent,
    payment_link: p.paymentLink,
    expires_at: p.expiresAt,
    utr: p.utr,
    rrn: p.rrn,
    payer_vpa: opts.list ? maskVpa(p.payerVpa) : p.payerVpa,
    customer: { name: p.customerName, mobile: opts.list ? maskMobile(p.customerMobile) : p.customerMobile, email: p.customerEmail },
    description: p.description,
    metadata: p.metadata,
    late_success: p.lateSuccess,
    requires_review: p.requiresReview,
    review_reason: opts.internal ? p.reviewReason : undefined,
    failure_code: p.failureCode,
    failure_reason: p.failureReason,
    success_at: p.successAt,
    settled_at: p.settledAt,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    ...(opts.internal ? { provider: opts.providerCode ?? null, provider_order_id: p.providerOrderId, provider_transaction_id: p.providerTransactionId, reseller_id: p.resellerId } : {}),
    ...(opts.refunds ? { refunds: opts.refunds.map(presentRefund) } : {}),
    ...(opts.attempts && opts.internal
      ? {
          attempts: opts.attempts.map((a) => ({
            attempt_no: a.attemptNo,
            provider: a.providerCode ?? a.providerId,
            status: a.status,
            error_kind: a.errorKind,
            error_code: a.errorCode,
            error_message: a.errorMessage,
            latency_ms: a.latencyMs,
            created_at: a.createdAt,
          })),
        }
      : {}),
  };
}
