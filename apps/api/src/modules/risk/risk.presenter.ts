import type { RiskActionRecord, RiskEvent, RiskRule } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';

export function presentRiskRule(r: RiskRule) {
  return {
    rule_id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    type: r.type,
    service: r.service,
    params: r.params,
    action: r.action,
    mode: r.mode,
    enabled: r.enabled,
    priority: r.priority,
    version: r.version,
    updated_at: r.updatedAt,
  };
}

export function presentRiskEvent(e: RiskEvent, merchantName: string | null) {
  return {
    event_id: e.id,
    rule_id: e.ruleId,
    rule_code: e.ruleCode,
    rule_version: e.ruleVersion,
    merchant_id: e.merchantId,
    merchant_name: merchantName,
    subject_type: e.subjectType,
    // Bank-account subjects are keyed blind indexes: show a short prefix only.
    subject_id: e.subjectType === 'BENEFICIARY_ACCOUNT' ? `${e.subjectId.slice(0, 12)}…` : e.subjectId,
    action: e.action,
    mode: e.mode,
    enforced: e.enforced,
    reason: e.reason,
    evidence: e.evidence,
    status: e.status,
    reviewed_by_id: e.reviewedById,
    reviewed_at: e.reviewedAt,
    review_note: e.reviewNote,
    created_at: e.createdAt,
  };
}

export function presentRiskAction(a: RiskActionRecord) {
  return {
    action_id: a.id,
    event_id: a.eventId,
    merchant_id: a.merchantId,
    type: a.type,
    hold_id: a.holdId,
    previous_value: a.previousValue,
    active: a.active,
    lifted_by_id: a.liftedById,
    lifted_at: a.liftedAt,
    lift_reason: a.liftReason,
    created_at: a.createdAt,
  };
}

export function presentRiskSubject(type: string, id: string, s: { status: string; amountMinor: bigint; reviewKind?: string | null; mode?: string; method?: string }) {
  return {
    type,
    id,
    status: s.status,
    amount: minorToMajorString(s.amountMinor),
    held_by_risk: s.reviewKind === 'RISK' && s.status === 'MANUAL_REVIEW',
    channel: s.mode ?? s.method ?? null,
  };
}
