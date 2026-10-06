import type { ComplianceAction, MerchantStatus } from '@pay2all/database';

/**
 * Merchant onboarding state machine (docs/ROADMAP.md Phase 2). The single source of truth for which
 * transitions exist; services apply them with a version-checked conditional update, so concurrent
 * reviewers can never both "win".
 *
 *   DRAFT ─submit─▶ SUBMITTED ─start─▶ UNDER_REVIEW ─approve─▶ APPROVED ⇄ SUSPENDED
 *                       ▲                 │  │
 *                       └──resubmit── MORE_INFORMATION_REQUIRED      └─reject─▶ REJECTED (terminal)
 */
export const MERCHANT_TRANSITIONS: Record<Exclude<ComplianceAction, 'CREATED'>, { from: MerchantStatus[]; to: MerchantStatus }> = {
  SUBMITTED: { from: ['DRAFT', 'MORE_INFORMATION_REQUIRED'], to: 'SUBMITTED' },
  REVIEW_STARTED: { from: ['SUBMITTED'], to: 'UNDER_REVIEW' },
  INFORMATION_REQUESTED: { from: ['UNDER_REVIEW'], to: 'MORE_INFORMATION_REQUIRED' },
  APPROVED: { from: ['UNDER_REVIEW'], to: 'APPROVED' },
  REJECTED: { from: ['UNDER_REVIEW'], to: 'REJECTED' },
  SUSPENDED: { from: ['APPROVED'], to: 'SUSPENDED' },
  REACTIVATED: { from: ['SUSPENDED'], to: 'APPROVED' },
};

export type MerchantTransition = keyof typeof MERCHANT_TRANSITIONS;

export function canTransition(from: MerchantStatus, action: MerchantTransition): boolean {
  return MERCHANT_TRANSITIONS[action].from.includes(from);
}

/** Statuses in which the applicant (merchant, reseller or staff) may edit onboarding data. */
export const EDITABLE_STATUSES: readonly MerchantStatus[] = ['DRAFT', 'MORE_INFORMATION_REQUIRED'];

export function isEditable(status: MerchantStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}
