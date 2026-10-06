'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { TransactionDetailsDrawer } from '@pay2all/ui/components/details-drawer';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FlaskConical, Loader2, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { fmt } from '@/features/ledger/format';
import { SANDBOX_TOOLS } from '@/features/payin/labels';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Payout } from '@/lib/api/types';
import { useCan, useMe } from '@/lib/auth/use-me';
import { IN_FLIGHT, MODE_LABELS, PURPOSE_LABELS, statusLabel } from './labels';

export function usePayout(id: string | null) {
  return useQuery({
    queryKey: ['payout', id],
    queryFn: () => api.get<Payout>(`/v1/payouts/${id}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data && IN_FLIGHT.includes(q.state.data.status) ? 4_000 : false),
  });
}

function useInvalidate(id: string) {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: ['payout', id] });
    await qc.invalidateQueries({ queryKey: ['payouts'] });
    await qc.invalidateQueries({ queryKey: ['balances'] });
  };
}

/** Sandbox-only: simulate the bank's answer for a sent payout. */
function SandboxPayoutActions({ p }: { p: Payout }) {
  const invalidate = useInvalidate(p.payout_id);
  const [busy, setBusy] = useState(false);
  const sent = p.status === 'PROCESSING' || p.status === 'PENDING';
  if (!SANDBOX_TOOLS || !(sent || p.status === 'SUCCESS')) return null;
  async function run(outcome: 'SUCCESS' | 'FAILED' | 'REVERSED') {
    setBusy(true);
    try {
      await api.post(`/v1/sandbox/payouts/${p.payout_id}/complete`, { outcome });
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border border-dashed p-3">
      <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium"><FlaskConical className="size-3.5" /> Sandbox — simulate the beneficiary bank</p>
      <div className="flex flex-wrap gap-2">
        {sent && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('SUCCESS')}>Credit succeeds</Button>}
        {sent && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('FAILED')}>Bank rejects</Button>}
        {p.status === 'SUCCESS' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('REVERSED')}>Bank returns funds</Button>}
      </div>
    </div>
  );
}

function ResolveReviewDialog({ p, open, onOpenChange }: { p: Payout; open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidate(p.payout_id);
  const [outcome, setOutcome] = useState<'SUCCESS' | 'FAILED'>('FAILED');
  const [utr, setUtr] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = reason.trim().length >= 10 && (outcome === 'FAILED' || /^[A-Za-z0-9]{6,40}$/.test(utr));
  async function submit() {
    setBusy(true);
    try {
      await api.post(`/v1/payouts/${p.payout_id}/review/resolve`, { outcome, reason: reason.trim(), ...(outcome === 'SUCCESS' ? { utr } : {}) });
      toast.success(outcome === 'SUCCESS' ? 'Marked successful and settled' : 'Marked failed and funds released');
      onOpenChange(false);
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve unknown payout</DialogTitle>
          <DialogDescription>Only with evidence from the bank statement or the provider. This moves money and is audited.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button variant={outcome === 'FAILED' ? 'default' : 'outline'} size="sm" onClick={() => setOutcome('FAILED')}>Not debited → release funds</Button>
            <Button variant={outcome === 'SUCCESS' ? 'default' : 'outline'} size="sm" onClick={() => setOutcome('SUCCESS')}>Debited → mark successful</Button>
          </div>
          {outcome === 'SUCCESS' && (
            <div className="space-y-1.5"><Label htmlFor="utr">UTR from the bank</Label><Input id="utr" value={utr} onChange={(e) => setUtr(e.target.value.trim())} className="font-mono" /></div>
          )}
          <div className="space-y-1.5"><Label htmlFor="evidence">Evidence</Label><Textarea id="evidence" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Provider ops confirmed by email on 6 Oct, ref #4412" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Resolve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PayoutDrawer({ payoutId, onClose }: { payoutId: string | null; onClose: () => void }) {
  const can = useCan();
  const { data: me } = useMe();
  const { data: p } = usePayout(payoutId);
  const invalidate = useInvalidate(payoutId ?? '');
  const [rejecting, setRejecting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const internal = me?.organization.type === 'PLATFORM';
  const isMaker = Boolean(p && me && p.created_by_id === me.user.id);

  async function approve() {
    if (!p) return;
    setBusy(true);
    try {
      const next = await api.post<Payout>(`/v1/payouts/${p.payout_id}/approve`, {});
      toast.success(next.status === 'QUEUED' ? 'Approved — the payout is on its way' : `Approved (${next.approvals_received}/${next.approvals_required})`);
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function reject(reason?: string) {
    if (!p) return;
    setBusy(true);
    try {
      await api.post(`/v1/payouts/${p.payout_id}/reject`, { reason });
      toast.success(isMaker ? 'Payout cancelled; funds released' : 'Payout rejected; funds released');
      setRejecting(false);
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const b = p?.beneficiary;
  return (
    <>
      <TransactionDetailsDrawer
        open={Boolean(payoutId)}
        onOpenChange={(o) => !o && onClose()}
        title={p ? <span className="flex items-center gap-2">{fmt(p.amount)} <StatusBadge status={p.status} /></span> : 'Payout'}
        subtitle={p && <span className="font-mono text-xs">{p.payout_id}</span>}
        sections={
          p && b
            ? [
                {
                  title: 'Beneficiary',
                  fields: [
                    { label: 'Name', value: b.name },
                    { label: b.upi_id ? 'UPI ID' : 'Account', value: b.upi_id ?? `${b.account_number_masked} · ${b.ifsc}${b.bank_name ? ` · ${b.bank_name}` : ''}`, mono: true },
                    { label: 'Verification', value: statusLabel(b.verification_status) },
                  ],
                },
                {
                  title: 'Payout',
                  fields: [
                    { label: 'Order ID', value: p.merchant_order_id, mono: true },
                    { label: 'Mode · purpose', value: `${MODE_LABELS[p.mode]} · ${PURPOSE_LABELS[p.purpose] ?? p.purpose}` },
                    { label: 'Created', value: `${formatDateTime(p.created_at)}${p.source !== 'DASHBOARD' ? ` (${p.source.toLowerCase()})` : ''}` },
                    ...(p.processed_at ? [{ label: 'Completed', value: formatDateTime(p.processed_at) }] : []),
                    { label: 'UTR', value: p.utr, mono: true },
                    ...(p.narration ? [{ label: 'Narration', value: p.narration }] : []),
                    ...(p.failure_reason ? [{ label: 'Reason', value: p.failure_reason }] : []),
                  ],
                },
                {
                  title: 'Amounts',
                  fields: [
                    { label: 'Amount', value: fmt(p.amount) },
                    { label: 'Fee', value: fmt(p.fee) },
                    { label: 'GST on fee', value: fmt(p.tax) },
                    { label: 'Total debited', value: <span className="font-medium">{fmt(p.total_debit)}</span> },
                  ],
                },
                ...(internal
                  ? [
                      {
                        title: 'Routing (internal)',
                        fields: [
                          { label: 'Provider', value: p.provider },
                          { label: 'Provider ref', value: p.provider_reference, mono: true },
                          ...(p.attempts ?? []).map((a) => ({ label: `Attempt ${a.attempt_no}`, value: `${a.provider} · ${a.status}${a.error_code ? ` (${a.error_kind}: ${a.error_code})` : ''} · ${a.reference}`, mono: true })),
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
            {p.status === 'MANUAL_REVIEW' && (
              <Alert>
                <TriangleAlert />
                <AlertTitle>Outcome unknown — funds are held</AlertTitle>
                <AlertDescription>
                  {p.review_reason ?? 'The provider has not confirmed this transfer. It is never re-sent automatically.'}
                  {internal && can('payout.review') && <Button size="sm" className="mt-2" onClick={() => setResolving(true)}>Resolve with evidence</Button>}
                </AlertDescription>
              </Alert>
            )}
            {p.status === 'APPROVAL_PENDING' && (
              <section className="space-y-2">
                <h4 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Approvals · {p.approvals_received}/{p.approvals_required}</h4>
                <p className="text-muted-foreground text-xs">Funds are reserved. {p.approval_expires_at ? `Auto-rejected if not approved by ${formatDateTime(p.approval_expires_at)}.` : ''}</p>
                <div className="flex flex-wrap gap-2">
                  {p.can_approve && <Button size="sm" disabled={busy} onClick={() => void approve()}><Check /> Approve</Button>}
                  {(p.can_approve || isMaker) && <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}><X /> {isMaker ? 'Cancel payout' : 'Reject'}</Button>}
                  {isMaker && <p className="text-muted-foreground w-full text-xs">You created this payout, so another team member must approve it.</p>}
                </div>
              </section>
            )}
            {(p.approvals?.length ?? 0) > 0 && (
              <ul className="divide-y rounded-lg border text-sm">
                {p.approvals!.map((a) => (
                  <li key={a.approver_id + a.created_at} className="flex items-center justify-between px-3 py-2">
                    <div><p className="font-medium">{a.approver_name ?? 'Team member'}</p><p className="text-muted-foreground text-xs">{formatDateTime(a.created_at)}{a.reason ? ` · ${a.reason}` : ''}</p></div>
                    <StatusBadge status={a.decision} />
                  </li>
                ))}
              </ul>
            )}
            {me?.organization.type === 'MERCHANT' && <SandboxPayoutActions p={p} />}
          </div>
        )}
      </TransactionDetailsDrawer>
      <ConfirmDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={isMaker ? 'Cancel this payout?' : 'Reject this payout?'}
        description="The reserved funds are returned to your available balance."
        confirmLabel={isMaker ? 'Cancel payout' : 'Reject'}
        destructive
        requireReason
        pending={busy}
        onConfirm={(reason) => void reject(reason)}
      />
      {p && <ResolveReviewDialog p={p} open={resolving} onOpenChange={setResolving} />}
    </>
  );
}
