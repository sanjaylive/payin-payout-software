import type { PayoutMode, PayoutStatus } from '@/lib/api/types';

export const MODE_LABELS: Record<PayoutMode, string> = { IMPS: 'IMPS', NEFT: 'NEFT', RTGS: 'RTGS', UPI: 'UPI' };
export const MODE_HINTS: Record<PayoutMode, string> = {
  IMPS: 'Instant, 24×7 · up to ₹5,00,000',
  NEFT: 'Batch, 24×7 · no minimum',
  RTGS: 'High value · from ₹2,00,000',
  UPI: 'Instant to a UPI ID · up to ₹1,00,000',
};
export const PURPOSE_LABELS: Record<string, string> = {
  VENDOR_PAYMENT: 'Vendor payment',
  CUSTOMER_PAYOUT: 'Customer payout',
  REFUND_PAYOUT: 'Refund',
  SALARY: 'Salary',
  API_PAYOUT: 'Other',
};
export const PAYOUT_STATUSES: PayoutStatus[] = ['APPROVAL_PENDING', 'QUEUED', 'PROCESSING', 'PENDING', 'SUCCESS', 'FAILED', 'REJECTED', 'REVERSED', 'MANUAL_REVIEW'];
export const IN_FLIGHT: PayoutStatus[] = ['QUEUED', 'PROCESSING', 'PENDING'];
export const statusLabel = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
