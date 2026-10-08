import type { InboxInput } from '@pay2all/database';
import type { MerchantEventType } from './merchant-events.service';

type Rule = Omit<InboxInput, 'organizationId'> & { platform?: boolean };
type Data = Record<string, unknown>;

/** Scalar payload field as text ('' / fallback for anything else). */
const str = (v: unknown, fallback = '') => (typeof v === 'string' || typeof v === 'number' ? String(v) : fallback);
const rupees = (v: unknown) => (typeof v === 'string' ? `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');
const ben = (d: Data) => {
  const b = (d.beneficiary ?? {}) as { name?: string; account_number_masked?: string; upi_id?: string };
  return [b.name, b.account_number_masked ?? b.upi_id].filter(Boolean).join(' · ');
};

/**
 * Which merchant events also ring the bell, for whom, and what they say (docs/NOTIFICATIONS.md §2).
 * Routine successes (each payment, each payout) deliberately don't — the bell is for things a
 * person should look at. Returned rules are created on the event's own transaction.
 */
export function inboxRulesFor(type: MerchantEventType, resourceId: string, d: Data): Rule[] {
  switch (type) {
    case 'payout.created': {
      const link = `/payout/transactions?payout=${resourceId}`;
      if (d.status === 'APPROVAL_PENDING') {
        return [{ audience: { permission: 'payout.approve', excludeUserIds: [d.created_by_id as string] }, category: 'PAYOUT', severity: 'WARNING', title: `Payout of ${rupees(d.amount)} needs your approval`, body: `${ben(d)} · ${str(d.merchant_order_id, '')}. Approve or reject before it expires.`, link: '/payout/approvals', resourceType: 'payout', resourceId, dedupeKey: `payout:${resourceId}:approval` }];
      }
      if (d.status === 'MANUAL_REVIEW' && d.review_kind === 'RISK') {
        return [
          { audience: { permission: 'payout.read' }, category: 'PAYOUT', severity: 'WARNING', title: `Payout of ${rupees(d.amount)} is under review`, body: `${ben(d)}. Pay2All is reviewing it before sending; the amount stays reserved.`, link, resourceType: 'payout', resourceId, dedupeKey: `payout:${resourceId}:risk-hold` },
          { platform: true, audience: { permission: 'risk.review' }, category: 'RISK', severity: 'WARNING', title: `Payout held for risk review — ${rupees(d.amount)}`, body: `Merchant payout ${str(d.merchant_order_id, resourceId)} is waiting for a decision.`, link: '/admin/risk/reviews', resourceType: 'payout', resourceId, dedupeKey: `payout:${resourceId}:risk-hold:platform` },
        ];
      }
      return [];
    }
    case 'payout.failed':
      return [{ audience: { permission: 'payout.read' }, category: 'PAYOUT', severity: 'WARNING', title: `Payout of ${rupees(d.amount)} failed`, body: `${ben(d)} · ${str(d.failure_reason, 'The bank rejected the transfer')}. The amount is back in your balance.`, link: `/payout/transactions?payout=${resourceId}`, resourceType: 'payout', resourceId, dedupeKey: `payout:${resourceId}:failed` }];
    case 'payout.reversed':
      return [{ audience: { permission: 'payout.read' }, category: 'PAYOUT', severity: 'CRITICAL', title: `Payout of ${rupees(d.amount)} was returned`, body: `${ben(d)} · the beneficiary bank sent it back. The principal is back in your balance.`, link: `/payout/transactions?payout=${resourceId}`, resourceType: 'payout', resourceId, dedupeKey: `payout:${resourceId}:reversed` }];
    case 'payout.rejected': {
      if (d.failure_code === 'RISK_DECLINED') {
        return [{ audience: { permission: 'payout.read' }, category: 'PAYOUT', severity: 'WARNING', title: `Payout of ${rupees(d.amount)} was declined`, body: `${ben(d)} · declined after review. The amount is back in your balance.`, link: `/payout/transactions?payout=${resourceId}`, resourceType: 'payout', resourceId, dedupeKey: `payout:${resourceId}:declined` }];
      }
      // Rejected by a checker (or expired): tell the maker.
      return d.failure_code === 'CANCELLED_BY_MAKER'
        ? []
        : [{ audience: { userIds: [d.created_by_id as string] }, category: 'PAYOUT', severity: 'INFO', title: `Your payout of ${rupees(d.amount)} was not approved`, body: `${ben(d)} · ${str(d.failure_reason, '')}`, link: `/payout/transactions?payout=${resourceId}`, resourceType: 'payout', resourceId, dedupeKey: `payout:${resourceId}:rejected` }];
    }
    case 'refund.failed':
      return [{ audience: { permission: 'payin.read' }, category: 'PAYMENT', severity: 'WARNING', title: `Refund of ${rupees(d.amount)} failed`, body: `${str(d.failure_reason, 'The provider could not refund it')}. The amount is back in your balance; you can try again.`, link: '/payin/refunds', resourceType: 'refund', resourceId, dedupeKey: `refund:${resourceId}:failed` }];
    case 'settlement.processed':
      return [{ audience: { permission: 'settlement.read' }, category: 'SETTLEMENT', severity: 'SUCCESS', title: `Settlement of ${rupees(d.net)} sent`, body: `${str(d.settlement_date, '')} · ${str(d.payment_count, '')} payments${d.utr ? ` · UTR ${str(d.utr)}` : ''}.`, link: '/settlements', resourceType: 'settlement', resourceId, dedupeKey: `settlement:${resourceId}:processed` }];
    case 'settlement.failed':
      return [{ audience: { permission: 'settlement.read' }, category: 'SETTLEMENT', severity: 'CRITICAL', title: `Settlement of ${rupees(d.net)} failed`, body: `${str(d.failure_reason, 'The bank transfer failed')}. The funds stay in your balance and will be settled again.`, link: '/settlements', resourceType: 'settlement', resourceId, dedupeKey: `settlement:${resourceId}:failed:${str(d.processed_at, '')}` }];
    case 'dispute.created': {
      const due = typeof d.respond_by === 'string' ? new Date(d.respond_by).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
      return [{ audience: { permission: 'dispute.respond' }, category: 'DISPUTE', severity: 'CRITICAL', title: `Dispute of ${rupees(d.amount)} — respond by ${due}`, body: `${str(d.reason, 'A customer disputed a payment')}. The amount is on hold until it's decided. Upload evidence to contest it.`, link: `/payin/disputes?dispute=${resourceId}`, resourceType: 'dispute', resourceId, dedupeKey: `dispute:${resourceId}:created` }];
    }
    case 'dispute.won':
      return [{ audience: { permission: 'dispute.read' }, category: 'DISPUTE', severity: 'SUCCESS', title: `Dispute won — ${rupees(d.amount)} released`, body: `${str(d.resolution_note, 'Decided in your favour')}. The held amount is back in your balance.`, link: `/payin/disputes?dispute=${resourceId}`, resourceType: 'dispute', resourceId, dedupeKey: `dispute:${resourceId}:won` }];
    case 'dispute.lost':
      return [{ audience: { permission: 'dispute.read' }, category: 'DISPUTE', severity: 'WARNING', title: `Dispute lost — ${rupees(d.amount)} debited`, body: `${str(d.resolution_note, 'Decided in the customer’s favour')}${d.fee && d.fee !== '0.00' ? ` · chargeback fee ${rupees(d.fee)} + GST` : ''}.`, link: `/payin/disputes?dispute=${resourceId}`, resourceType: 'dispute', resourceId, dedupeKey: `dispute:${resourceId}:lost` }];
    default:
      return [];
  }
}
