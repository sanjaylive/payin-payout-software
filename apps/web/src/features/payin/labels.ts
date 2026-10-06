import { ApiError } from '@/lib/api/client';
import type { PayinMethod, PaymentStatus } from '@/lib/api/types';

export const METHOD_LABELS: Record<PayinMethod, string> = { UPI_QR: 'UPI QR', UPI_INTENT: 'UPI intent', PAYMENT_LINK: 'Payment link' };

export const PAYMENT_STATUSES: PaymentStatus[] = ['CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'SETTLED'];

export const OPEN_STATUSES: PaymentStatus[] = ['CREATED', 'PENDING'];
export const CAPTURED_STATUSES: PaymentStatus[] = ['SUCCESS', 'SETTLEMENT_PENDING', 'SETTLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED'];

/** A fresh Idempotency-Key per user action; reused if that same action is retried. */
export function newIdempotencyKey(): string {
  return `web_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Sandbox tools (simulate customer payment) — dev builds, or explicitly enabled sandbox deployments. */
export const SANDBOX_TOOLS = process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_ENABLE_SANDBOX_TOOLS === 'true';

/** After a definitive 4xx the server has recorded that outcome for the key — a corrected retry needs a new one. */
export function keyAfterError(err: unknown, current: string): string {
  return err instanceof ApiError && err.status < 500 ? newIdempotencyKey() : current;
}
