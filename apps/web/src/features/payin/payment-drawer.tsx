'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { TransactionDetailsDrawer } from '@pay2all/ui/components/details-drawer';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FlaskConical, TriangleAlert, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { fmt, majorToMinor } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Payment } from '@/lib/api/types';
import { useCan, useMe } from '@/lib/auth/use-me';
import { CAPTURED_STATUSES, METHOD_LABELS, OPEN_STATUSES, SANDBOX_TOOLS } from './labels';
import { PaymentQr } from './payment-qr';
import { RefundDialog } from './refund-dialog';

export function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`));
}

export function usePayment(paymentId: string | null, opts: { live?: boolean } = {}) {
  return useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => api.get<Payment>(`/v1/payments/${paymentId}`),
    enabled: Boolean(paymentId),
    // Poll while the customer may still be paying.
    refetchInterval: (q) => (opts.live && q.state.data && OPEN_STATUSES.includes(q.state.data.status) ? 3_000 : false),
  });
}

/** Sandbox-only: simulate the customer paying or declining (signed mock callback on the server). */
export function SandboxActions({ payment }: { payment: Payment }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  if (!SANDBOX_TOOLS || !OPEN_STATUSES.includes(payment.status)) return null;
  async function run(outcome: 'SUCCESS' | 'FAILED') {
    setBusy(outcome);
    try {
      await api.post(`/v1/sandbox/payments/${payment.payment_id}/complete`, { outcome });
      await qc.invalidateQueries({ queryKey: ['payment', payment.payment_id] });
      await qc.invalidateQueries({ queryKey: ['payments'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="rounded-lg border border-dashed p-3">
      <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium"><FlaskConical className="size-3.5" /> Sandbox — simulate the customer</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('SUCCESS')}>Customer pays</Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('FAILED')}>Customer declines</Button>
      </div>
    </div>
  );
}

export function PaymentDrawer({ paymentId, onClose }: { paymentId: string | null; onClose: () => void }) {
  const can = useCan();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: p } = usePayment(paymentId, { live: true });
  const [refundOpen, setRefundOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const isMerchant = me?.organization.type === 'MERCHANT';
  const internal = me?.organization.type === 'PLATFORM';

  async function accept(reason?: string) {
    if (!p) return;
    setReviewing(true);
    try {
      await api.post(`/v1/payments/${p.payment_id}/review/accept`, { reason });
      toast.success('Late payment accepted and captured');
      setReviewOpen(false);
      await qc.invalidateQueries({ queryKey: ['payment', p.payment_id] });
      await qc.invalidateQueries({ queryKey: ['payments'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setReviewing(false);
    }
  }

  // Paise as bigint — never floats for money.
  const refundable = p
    ? majorToMinor(p.amount) - majorToMinor(p.refunded_amount) - (p.refunds ?? []).filter((r) => ['CREATED', 'PENDING', 'MANUAL_REVIEW'].includes(r.status)).reduce((s, r) => s + majorToMinor(r.amount), 0n)
    : 0n;

  return (
    <>
      <TransactionDetailsDrawer
        open={Boolean(paymentId)}
        onOpenChange={(o) => !o && onClose()}
        title={p ? <span className="flex items-center gap-2">{fmt(p.amount)} <StatusBadge status={p.status} /></span> : 'Payment'}
        subtitle={p && <span className="font-mono text-xs">{p.payment_id}</span>}
        sections={
          p
            ? [
                {
                  title: 'Payment',
                  fields: [
                    { label: 'Order ID', value: p.merchant_order_id, mono: true },
                    { label: 'Method', value: METHOD_LABELS[p.method] },
                    { label: 'Created', value: formatDateTime(p.created_at) },
                    { label: OPEN_STATUSES.includes(p.status) ? 'Expires' : 'Completed', value: formatDateTime(OPEN_STATUSES.includes(p.status) ? p.expires_at : (p.success_at ?? p.updated_at)) },
                    ...(p.description ? [{ label: 'Description', value: p.description }] : []),
                    ...(p.failure_reason ? [{ label: 'Failure', value: p.failure_reason }] : []),
                  ],
                },
                {
                  title: 'Amounts',
                  fields: [
                    { label: 'Amount', value: fmt(p.amount) },
                    { label: 'Fee', value: fmt(p.fee) },
                    { label: 'GST on fee', value: fmt(p.tax) },
                    { label: 'Net to you', value: <span className="font-medium">{fmt(p.net_amount)}</span> },
                    ...(p.refunded_amount !== '0.00' ? [{ label: 'Refunded', value: fmt(p.refunded_amount) }] : []),
                  ],
                },
                {
                  title: 'Payer & bank reference',
                  fields: [
                    { label: 'Customer', value: [p.customer.name, p.customer.mobile, p.customer.email].filter(Boolean).join(' · ') || '—' },
                    { label: 'Payer VPA', value: p.payer_vpa, mono: true },
                    { label: 'UTR', value: p.utr, mono: true },
                    { label: 'RRN', value: p.rrn, mono: true },
                  ],
                },
                ...(internal
                  ? [
                      {
                        title: 'Routing (internal)',
                        fields: [
                          { label: 'Provider', value: p.provider },
                          { label: 'Provider order', value: p.provider_order_id, mono: true },
                          { label: 'Provider txn', value: p.provider_transaction_id, mono: true },
                          ...(p.attempts ?? []).map((a) => ({ label: `Attempt ${a.attempt_no}`, value: `${a.provider} · ${a.status}${a.error_code ? ` (${a.error_kind}: ${a.error_code})` : ''}${a.latency_ms !== null ? ` · ${a.latency_ms} ms` : ''}` })),
                        ],
                      },
                    ]
                  : []),
              ]
            : []
        }
      >
        {p && (
          <div className="space-y-4">
            {p.requires_review && (
              <Alert>
                <TriangleAlert />
                <AlertTitle>Held for review</AlertTitle>
                <AlertDescription>
                  {p.review_reason ?? 'The provider reported an outcome that needs a manual check. Funds are not credited until it is resolved.'}
                  {internal && can('risk.review') && !p.review_reason?.startsWith('Provider reported') && (
                    <Button size="sm" className="mt-2" onClick={() => setReviewOpen(true)}>Accept late payment</Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {p.late_success && <p className="text-muted-foreground text-xs">Confirmed by the bank after the payment window had closed (late success).</p>}
            {OPEN_STATUSES.includes(p.status) && p.qr && (
              <div className="flex flex-col items-center gap-2 rounded-lg border p-4">
                <PaymentQr payload={p.qr} size={180} />
                <p className="text-muted-foreground text-xs">Waiting for the customer to pay…</p>
                <div className="flex gap-2">
                  {p.upi_intent && <Button size="sm" variant="outline" onClick={() => copy(p.upi_intent!, 'UPI link')}><Copy /> UPI link</Button>}
                  {p.payment_link && <Button size="sm" variant="outline" onClick={() => copy(p.payment_link!, 'Payment link')}><Copy /> Payment link</Button>}
                </div>
              </div>
            )}
            {isMerchant && <SandboxActions payment={p} />}
            {(p.refunds?.length ?? 0) > 0 && (
              <section>
                <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">Refunds</h4>
                <ul className="divide-y rounded-lg border">
                  {p.refunds!.map((r) => (
                    <li key={r.refund_id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div>
                        <p className="tabular font-medium">{fmt(r.amount)}</p>
                        <p className="text-muted-foreground text-xs">{formatDateTime(r.created_at)}{r.failure_reason ? ` · ${r.failure_reason}` : ''}</p>
                      </div>
                      <StatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {isMerchant && can('payin.refund') && CAPTURED_STATUSES.includes(p.status) && refundable > 0n && (
              <Button variant="outline" onClick={() => setRefundOpen(true)}><Undo2 /> Refund</Button>
            )}
          </div>
        )}
      </TransactionDetailsDrawer>
      {p && <RefundDialog payment={p} open={refundOpen} onOpenChange={setRefundOpen} refundableMinor={refundable} />}
      <ConfirmDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        title="Accept late payment?"
        description="This captures the payment now and credits the merchant. Confirm the UTR against the bank statement first."
        confirmLabel="Accept and capture"
        requireReason
        pending={reviewing}
        onConfirm={(reason) => void accept(reason)}
      />
    </>
  );
}
