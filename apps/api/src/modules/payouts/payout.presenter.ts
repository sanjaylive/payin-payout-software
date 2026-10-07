import type { Beneficiary, BulkPayoutBatch, BulkPayoutRow, Payout, PayoutApproval, PayoutAttempt } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';

const major = (v: bigint) => minorToMajorString(v);
const maskMobile = (m: string | null) => (m ? `${m.slice(0, 3)}******${m.slice(-4)}` : null);

/** Beneficiary as the API shows it: masked account only, never the number or its hash. */
export function presentBeneficiary(b: Beneficiary, opts: { list?: boolean } = {}) {
  return {
    beneficiary_id: b.id,
    merchant_id: b.merchantId,
    name: b.name,
    type: b.type,
    account_number_masked: b.accountNumberMasked,
    ifsc: b.ifsc,
    bank_name: b.bankName,
    upi_id: b.upiId,
    mobile: opts.list ? maskMobile(b.mobile) : b.mobile,
    email: b.email,
    verification_status: b.verificationStatus,
    verified_name: b.verifiedName,
    name_match_score: b.nameMatchScore,
    verified_at: b.verifiedAt,
    verification_failure: b.verificationFailure,
    blocked_reason: b.blockedReason,
    created_at: b.createdAt,
  };
}

export interface PayoutPresentOptions {
  internal?: boolean;
  providerCode?: string | null;
  attempts?: (PayoutAttempt & { providerCode?: string })[];
  approvals?: (PayoutApproval & { approverName?: string })[];
  /** Can the viewing user approve this payout right now? */
  canApprove?: boolean;
}

export function presentPayout(p: Payout, opts: PayoutPresentOptions = {}) {
  return {
    payout_id: p.id,
    merchant_id: p.merchantId,
    merchant_order_id: p.merchantOrderId,
    amount: major(p.amountMinor),
    fee: major(p.feeMinor),
    tax: major(p.taxMinor),
    total_debit: major(p.totalDebitMinor),
    currency: p.currency,
    mode: p.mode,
    purpose: p.purpose,
    status: p.status,
    source: p.source,
    beneficiary: p.beneficiarySnapshot,
    narration: p.narration,
    metadata: p.metadata,
    approvals_required: p.approvalsRequired,
    approvals_received: p.approvalsReceived,
    approval_expires_at: p.approvalExpiresAt,
    utr: p.utr,
    failure_code: p.failureCode,
    failure_reason: p.failureReason,
    review_reason: p.reviewReason,
    // RISK = held before sending (nothing left the account); UNKNOWN_OUTCOME = sent, awaiting evidence.
    review_kind: p.reviewKind,
    bulk_batch_id: p.bulkBatchId,
    created_by_id: p.createdById,
    processed_at: p.processedAt,
    reversed_at: p.reversedAt,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    ...(opts.canApprove !== undefined ? { can_approve: opts.canApprove } : {}),
    ...(opts.internal ? { provider: opts.providerCode ?? null, provider_reference: p.providerReference, reseller_id: p.resellerId } : {}),
    ...(opts.approvals
      ? { approvals: opts.approvals.map((a) => ({ approver_id: a.approverId, approver_name: a.approverName ?? null, decision: a.decision, reason: a.reason, created_at: a.createdAt })) }
      : {}),
    ...(opts.attempts && opts.internal
      ? {
          attempts: opts.attempts.map((a) => ({
            attempt_no: a.attemptNo,
            provider: a.providerCode ?? a.providerId,
            reference: a.reference,
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

export function presentBatch(b: BulkPayoutBatch, rows?: BulkPayoutRow[]) {
  return {
    batch_id: b.id,
    file_name: b.fileName,
    status: b.status,
    total_rows: b.totalRows,
    valid_rows: b.validRows,
    total_amount: major(b.totalAmountMinor),
    approvals_required: b.batchApprovals,
    created_count: b.createdCount,
    failed_count: b.failedCount,
    created_at: b.createdAt,
    confirmed_at: b.confirmedAt,
    completed_at: b.completedAt,
    ...(rows
      ? {
          rows: rows.map((r) => ({
            row_no: r.rowNo,
            merchant_order_id: r.merchantOrderId,
            amount: r.amountMinor === null ? null : major(r.amountMinor),
            mode: r.mode,
            beneficiary: r.beneficiaryLabel,
            status: r.status,
            errors: r.errors,
            payout_id: r.payoutId,
          })),
        }
      : {}),
  };
}
