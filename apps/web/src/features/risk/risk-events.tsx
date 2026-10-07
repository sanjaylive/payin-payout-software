'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { TransactionDetailsDrawer } from '@pay2all/ui/components/details-drawer';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Loader2, ShieldX, Unlock } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { RiskActionRecord, RiskEvent } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { ACTION_LABELS, EVENT_STATUS_TONE } from './risk-labels';

const SUBJECT_LABELS: Record<string, string> = { PAYMENT: 'Payin', PAYOUT: 'Payout', MERCHANT: 'Merchant', BENEFICIARY_ACCOUNT: 'Bank account' };

function humanKey(k: string) {
  return k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function EvidenceList({ evidence }: { evidence: Record<string, unknown> }) {
  const { rule_params: params, ...observed } = evidence as Record<string, unknown> & { rule_params?: Record<string, unknown> };
  const row = (k: string, v: unknown) => (
    <div key={k} className="grid grid-cols-2 gap-3 px-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{humanKey(k)}</dt>
      <dd className="tabular font-mono text-xs leading-5 break-all">{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
    </div>
  );
  return (
    <section className="space-y-3">
      <div>
        <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">What was observed</h4>
        <dl className="divide-y rounded-lg border">{Object.entries(observed).map(([k, v]) => row(k, v))}</dl>
      </div>
      {params && (
        <div>
          <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">Rule parameters at the time</h4>
          <dl className="divide-y rounded-lg border">{Object.entries(params).map(([k, v]) => row(k, v))}</dl>
        </div>
      )}
    </section>
  );
}

function ResolveDialog({ event, decision, onClose }: { event: RiskEvent | null; decision: 'CLEAR' | 'CONFIRM'; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const heldPayout = event?.subject_type === 'PAYOUT';
  async function submit() {
    if (!event) return;
    setBusy(true);
    try {
      await api.post(`/v1/risk/events/${event.event_id}/resolve`, { decision, note: note.trim() });
      toast.success(decision === 'CLEAR' ? 'Cleared — controls lifted' : 'Confirmed');
      await Promise.all([qc.invalidateQueries({ queryKey: ['risk-events'] }), qc.invalidateQueries({ queryKey: ['risk-event'] }), qc.invalidateQueries({ queryKey: ['risk-actions'] })]);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(event)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{decision === 'CLEAR' ? 'Clear as false positive' : 'Confirm risk'}</DialogTitle>
          <DialogDescription>
            {decision === 'CLEAR'
              ? `Lifts the controls this event applied${heldPayout ? ' and releases the held payout to approvals or the send queue' : ''}.`
              : `Keeps the controls in place${heldPayout ? ' and rejects the held payout, returning the reserved funds to the merchant’s balance' : ''}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="rv-note">Review note (audited)</Label>
          <Textarea id="rv-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked and why" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={decision === 'CONFIRM' ? 'destructive' : 'default'} disabled={note.trim().length < 5 || busy} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />} {decision === 'CLEAR' ? 'Clear' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EventDrawer({ eventId, onClose }: { eventId: string | null; onClose: () => void }) {
  const can = useCan();
  const q = useQuery({ queryKey: ['risk-event', eventId], queryFn: () => api.get<RiskEvent>(`/v1/risk/events/${eventId}`), enabled: Boolean(eventId) });
  const [resolving, setResolving] = useState<'CLEAR' | 'CONFIRM' | null>(null);
  const e = q.data;
  return (
    <>
      <TransactionDetailsDrawer
        open={Boolean(eventId)}
        onOpenChange={(o) => !o && onClose()}
        title={e ? e.rule_code : 'Risk event'}
        subtitle={e && <span className="flex items-center gap-2"><StatusBadge status={e.status} tone={EVENT_STATUS_TONE[e.status]} />{e.enforced ? 'Enforced' : 'Monitor only'}</span>}
        sections={
          e
            ? [
                {
                  title: 'Event',
                  fields: [
                    { label: 'Why', value: e.reason },
                    { label: 'Action', value: ACTION_LABELS[e.action] },
                    { label: 'Merchant', value: e.merchant_name ?? e.merchant_id ?? 'Several (see evidence)' },
                    { label: SUBJECT_LABELS[e.subject_type] ?? e.subject_type, value: e.subject_id, mono: true },
                    ...(e.subject ? [{ label: 'Now', value: `${e.subject.status} · ₹${e.subject.amount}${e.subject.held_by_risk ? ' · held by risk' : ''}` }] : []),
                    { label: 'Rule version', value: `v${e.rule_version}` },
                    { label: 'Raised', value: formatDateTime(e.created_at) },
                    ...(e.reviewed_at ? [{ label: 'Reviewed', value: `${formatDateTime(e.reviewed_at)} — ${e.review_note ?? ''}` }] : []),
                  ],
                },
              ]
            : []
        }
      >
        {e && <EvidenceList evidence={e.evidence} />}
        {e?.actions && e.actions.length > 0 && (
          <section>
            <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">Controls applied</h4>
            <ul className="divide-y rounded-lg border text-sm">
              {e.actions.map((a) => (
                <li key={a.action_id} className="flex items-center justify-between px-3 py-2">
                  <span>{ACTION_LABELS[a.type]}</span>
                  <StatusBadge status={a.active ? 'ACTIVE' : 'LIFTED'} tone={a.active ? 'warning' : 'neutral'} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {e?.status === 'OPEN' && can('risk.review') && (
          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={() => setResolving('CLEAR')}><CircleCheck /> Clear</Button>
            <Button className="flex-1" variant="destructive" onClick={() => setResolving('CONFIRM')}><ShieldX /> Confirm risk</Button>
          </div>
        )}
      </TransactionDetailsDrawer>
      <ResolveDialog key={resolving ?? 'none'} event={resolving ? (e ?? null) : null} decision={resolving ?? 'CLEAR'} onClose={() => setResolving(null)} />
    </>
  );
}

/** Event log (all statuses) or the manual review queue (`reviewQueue`: OPEN only). */
export function RiskEventsTable({ reviewQueue = false }: { reviewQueue?: boolean }) {
  const pager = useCursorPagination();
  const [status, setStatus] = useState(reviewQueue ? 'OPEN' : 'ALL');
  const [enforced, setEnforced] = useState('ALL');
  const [selected, setSelected] = useState<string | null>(null);
  const query = { limit: 50, cursor: pager.cursor, status: status === 'ALL' ? undefined : status, enforced: enforced === 'ALL' ? undefined : enforced };
  const events = useQuery({ queryKey: ['risk-events', query], queryFn: () => api.list<RiskEvent>('/v1/risk/events', query), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  return (
    <>
      <DataTable
        rows={events.data?.data}
        loading={events.isFetching}
        error={toTableError(events.error)}
        rowKey={(e) => e.event_id}
        onRowClick={(e) => setSelected(e.event_id)}
        empty={reviewQueue ? { title: 'Nothing waiting for review', description: 'Held payouts and enforced controls appear here.' } : { title: 'No risk events' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(events.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(events.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        toolbar={
          reviewQueue ? undefined : (
            <>
              <Select value={status} onValueChange={(v) => { setStatus(v); pager.reset(); }}>
                <SelectTrigger className="w-40" aria-label="Status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  <SelectItem value="OPEN">Open</SelectItem>
                  <SelectItem value="RECORDED">Recorded</SelectItem>
                  <SelectItem value="CLEARED">Cleared</SelectItem>
                  <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={enforced} onValueChange={(v) => { setEnforced(v); pager.reset(); }}>
                <SelectTrigger className="w-48" aria-label="Mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Enforced + monitor</SelectItem>
                  <SelectItem value="true">Enforced</SelectItem>
                  <SelectItem value="false">Monitor only</SelectItem>
                </SelectContent>
              </Select>
            </>
          )
        }
        columns={[
          { id: 'time', header: 'Raised', cell: (e) => <span className="text-sm whitespace-nowrap">{formatDateTime(e.created_at)}</span> },
          { id: 'rule', header: 'Rule', cell: (e) => <span className="font-mono text-xs">{e.rule_code}</span> },
          { id: 'merchant', header: 'Merchant', cell: (e) => <span className="text-sm">{e.merchant_name ?? (e.merchant_id ? e.merchant_id : '—')}</span> },
          { id: 'why', header: 'Why', className: 'min-w-56 whitespace-normal', cell: (e) => <span className="text-muted-foreground line-clamp-2 text-sm">{e.reason}</span> },
          { id: 'action', header: 'Action', cell: (e) => <span className="text-sm whitespace-nowrap">{ACTION_LABELS[e.action]}{!e.enforced && <span className="text-muted-foreground"> (monitor)</span>}</span> },
          { id: 'status', header: 'Status', cell: (e) => <StatusBadge status={e.status} tone={EVENT_STATUS_TONE[e.status]} /> },
        ]}
      />
      <EventDrawer eventId={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function LiftDialog({ action, onClose }: { action: RiskActionRecord | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!action) return;
    setBusy(true);
    try {
      await api.post(`/v1/risk/actions/${action.action_id}/lift`, { reason: reason.trim() });
      toast.success('Control lifted');
      await qc.invalidateQueries({ queryKey: ['risk-actions'] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(action)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Lift {action ? ACTION_LABELS[action.type].toLowerCase() : ''}</DialogTitle>
          <DialogDescription>{action?.merchant_name ?? action?.merchant_id}. If other events still apply the same control, it stays on until the last one is lifted.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5"><Label htmlFor="lift-reason">Reason (audited)</Label><Textarea id="lift-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={reason.trim().length < 5 || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Lift</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Merchant-level controls currently in force (settlement holds, disabled services). */
export function ActiveRiskControls() {
  const can = useCan();
  const q = useQuery({ queryKey: ['risk-actions'], queryFn: () => api.get<RiskActionRecord[]>('/v1/risk/actions', { active: 'true' }) });
  const [lifting, setLifting] = useState<RiskActionRecord | null>(null);
  return (
    <>
      <DataTable
        rows={q.data}
        loading={q.isFetching}
        error={toTableError(q.error)}
        rowKey={(a) => a.action_id}
        empty={{ title: 'No active risk controls' }}
        columns={[
          { id: 'merchant', header: 'Merchant', cell: (a) => <span className="font-medium">{a.merchant_name ?? a.merchant_id}</span> },
          { id: 'control', header: 'Control', cell: (a) => <StatusBadge status={ACTION_LABELS[a.type].toUpperCase()} tone="warning" /> },
          { id: 'rule', header: 'Rule', className: 'min-w-56 whitespace-normal', cell: (a) => <div className="space-y-0.5"><p className="font-mono text-xs">{a.rule_code}</p><p className="text-muted-foreground line-clamp-2 text-xs">{a.event_reason}</p></div> },
          { id: 'since', header: 'Since', cell: (a) => <span className="text-sm whitespace-nowrap">{formatDateTime(a.created_at)}</span> },
          { id: 'lift', header: '', align: 'right', cell: (a) => (can('risk.review') ? <Button size="sm" variant="outline" onClick={() => setLifting(a)}><Unlock /> Lift</Button> : null) },
        ]}
      />
      <LiftDialog key={lifting?.action_id ?? 'none'} action={lifting} onClose={() => setLifting(null)} />
    </>
  );
}
