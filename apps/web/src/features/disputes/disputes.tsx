'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardHeader } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@pay2all/ui/components/ui/sheet';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime, formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, CheckCircle2, FileText, Gavel, Loader2, Lock, Paperclip, Plus, ShieldAlert, Upload, XCircle } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, apiDownload, apiRequest, apiUpload } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { DisputeRow, DisputeSummary } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const KEY = ['disputes'];
const inr = (v: string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS: Record<DisputeRow['status'], { label: string; cls: string }> = {
  OPEN: { label: 'Needs response', cls: 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300' },
  UNDER_REVIEW: { label: 'Under review', cls: 'bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300' },
  WON: { label: 'Won', cls: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300' },
  LOST: { label: 'Lost', cls: 'bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-300' },
};

function StatusPill({ d }: { d: DisputeRow }) {
  const s = STATUS[d.status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', d.overdue ? 'bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-300' : s.cls)}>
      {d.overdue ? 'Overdue' : d.accepted ? 'Accepted' : s.label}
    </span>
  );
}

function dueText(d: DisputeRow) {
  const ms = new Date(d.respond_by).getTime() - Date.now();
  if (ms < 0) return `deadline passed ${formatRelative(d.respond_by)}`;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return days > 0 ? `${days}d ${hours}h left` : `${hours}h left`;
}

/** Disputes list + detail. `admin` adds opening and deciding; merchants add evidence, submit or accept. */
export function Disputes({ admin = false }: { admin?: boolean }) {
  const can = useCan();
  const params = useSearchParams();
  const [tab, setTab] = useState<'ALL' | DisputeRow['status']>('ALL');
  const [selected, setSelected] = useState<string | null>(params.get('dispute'));
  const [opening, setOpening] = useState(false);
  const summary = useQuery({ queryKey: [...KEY, 'summary'], queryFn: () => api.get<DisputeSummary>('/v1/disputes/summary') });
  const list = useInfiniteQuery({
    queryKey: [...KEY, tab],
    queryFn: ({ pageParam }) => apiRequest<DisputeRow[]>('/v1/disputes', { query: { status: tab === 'ALL' ? undefined : tab, limit: 25, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta?.has_more ? (last.meta.next_cursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={admin ? 'Waiting for merchants' : 'Needs your response'} value={summary.data?.needs_response ?? '—'} icon={AlarmClock} loading={summary.isLoading} />
        <StatCard label="Past deadline" value={summary.data?.overdue ?? '—'} icon={ShieldAlert} loading={summary.isLoading} />
        <StatCard label="Amount on hold" value={summary.data ? inr(summary.data.held_amount) : '—'} icon={Lock} hint={`${summary.data?.open ?? 0} open`} loading={summary.isLoading} />
        <StatCard label="Won / lost" value={summary.data ? `${summary.data.won} / ${summary.data.lost}` : '—'} icon={Gavel} loading={summary.isLoading} />
      </div>
      <Card className="gap-0 overflow-hidden pt-0 shadow-none">
        <CardHeader className="border-b pt-4 [.border-b]:pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
              <TabsList>
                <TabsTrigger value="ALL">All</TabsTrigger>
                <TabsTrigger value="OPEN">Needs response</TabsTrigger>
                <TabsTrigger value="UNDER_REVIEW">Under review</TabsTrigger>
                <TabsTrigger value="WON">Won</TabsTrigger>
                <TabsTrigger value="LOST">Lost</TabsTrigger>
              </TabsList>
            </Tabs>
            {admin && can('dispute.manage') && (
              <Button onClick={() => setOpening(true)}>
                <Plus /> Open dispute
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {list.isError ? (
            <div className="p-6">
              <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
            </div>
          ) : list.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 p-12 text-center text-sm">
              <CheckCircle2 className="size-7 text-emerald-600" /> No disputes here.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Dispute</th>
                    {admin && <th className="hidden px-4 py-2.5 font-medium md:table-cell">Merchant</th>}
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="hidden px-4 py-2.5 font-medium md:table-cell">Respond by</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((d) => (
                    <tr key={d.id} className="hover:bg-muted/30 cursor-pointer" onClick={() => setSelected(d.id)}>
                      <td className="max-w-[18rem] px-4 py-3">
                        <p className="truncate font-medium">{d.reason}</p>
                        <p className="text-muted-foreground truncate font-mono text-xs">
                          {d.reason_code} · {d.payment_id}
                        </p>
                      </td>
                      {admin && <td className="hidden max-w-[12rem] truncate px-4 py-3 md:table-cell">{d.merchant_name}</td>}
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">{inr(d.amount)}</td>
                      <td className="px-4 py-3">
                        <StatusPill d={d} />
                      </td>
                      <td className="text-muted-foreground hidden px-4 py-3 md:table-cell" title={formatDateTime(d.respond_by)}>
                        {d.status === 'OPEN' ? dueText(d) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.hasNextPage && (
                <div className="border-t p-3 text-center">
                  <Button variant="ghost" size="sm" onClick={() => void list.fetchNextPage()}>
                    Load more
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <DisputeSheet id={selected} admin={admin} onClose={() => setSelected(null)} />
      {admin && <OpenDisputeDialog open={opening} onOpenChange={setOpening} onOpened={(id) => setSelected(id)} />}
    </div>
  );
}

function DisputeSheet({ id, admin, onClose }: { id: string | null; admin: boolean; onClose: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [...KEY, 'one', id], queryFn: () => api.get<DisputeRow>(`/v1/disputes/${id}`), enabled: Boolean(id) });
  const file = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [outcome, setOutcome] = useState<'WON' | 'LOST' | null>(null);
  const [decision, setDecision] = useState({ note: '', fee: '' });
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    try {
      await fn();
      toast.success(done);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const respond = !admin && can('dispute.respond') && d?.status === 'OPEN';

  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {!d ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <StatusPill d={d} />
                <span className="text-muted-foreground font-mono text-xs">{d.reason_code}</span>
              </div>
              <SheetTitle className="text-xl">{inr(d.amount)} disputed</SheetTitle>
              <SheetDescription>{d.reason}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-4 pb-8">
              {d.status === 'OPEN' && (
                <div className={cn('flex items-start gap-2 rounded-lg border p-3 text-sm', d.overdue ? 'border-rose-500/30 bg-rose-500/5' : 'border-amber-500/30 bg-amber-500/5')}>
                  <AlarmClock className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {admin ? 'Waiting for the merchant’s evidence' : 'Respond'} by <strong>{formatDateTime(d.respond_by)}</strong> ({dueText(d)}). The amount stays on hold until the dispute is decided.
                  </span>
                </div>
              )}
              <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm">
                <div>
                  <dt className="text-muted-foreground text-xs">Payment</dt>
                  <dd className="truncate font-mono text-xs">{d.payment?.merchant_order_id ?? d.payment_id}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Paid</dt>
                  <dd>
                    {d.payment ? inr(d.payment.amount) : '—'} · {d.payment?.method.replace(/_/g, ' ').toLowerCase()}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Customer</dt>
                  <dd className="truncate">{d.payment?.customer_name ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">UTR / case</dt>
                  <dd className="truncate font-mono text-xs">{[d.payment?.utr, d.provider_case_id].filter(Boolean).join(' · ') || '—'}</dd>
                </div>
                {admin && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground text-xs">Merchant</dt>
                    <dd>{d.merchant_name}</dd>
                  </div>
                )}
              </dl>

              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Paperclip className="size-4" /> Evidence
                </h3>
                {(d.evidence ?? []).length === 0 ? (
                  <p className="text-muted-foreground text-sm">No files yet.</p>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {d.evidence!.map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm">{e.file_name}</p>
                          <p className="text-muted-foreground truncate text-xs">{e.description ?? `${Math.ceil(e.size_bytes / 1024)} KB`} · {formatRelative(e.created_at)}</p>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => void apiDownload(`/v1/disputes/${d.id}/evidence/${e.id}`, e.file_name).catch((err: unknown) => toast.error(errorMessage(err)))}>
                          <FileText /> Open
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {d.merchant_note && <p className="bg-muted/50 rounded-lg p-3 text-sm whitespace-pre-line">“{d.merchant_note}”</p>}
                {respond && (
                  <div className="space-y-2 rounded-lg border border-dashed p-3">
                    <Input aria-label="What this file shows" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="What this file shows, e.g. signed delivery receipt" />
                    <input
                      ref={file}
                      type="file"
                      accept="application/pdf,image/png,image/jpeg,image/webp"
                      className="hidden"
                      aria-label="Evidence file"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const form = new FormData();
                        if (description.trim()) form.append('description', description.trim());
                        form.append('file', f);
                        void run('upload', () => apiUpload(`/v1/disputes/${d.id}/evidence`, form), 'File added').then(() => {
                          setDescription('');
                          if (file.current) file.current.value = '';
                        });
                      }}
                    />
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => file.current?.click()}>
                      {busy === 'upload' ? <Loader2 className="animate-spin" /> : <Upload />} Add file (PDF or image, 5 MB)
                    </Button>
                    <p className="text-muted-foreground text-xs">Useful: invoice, delivery or service proof, customer conversations, your refund / cancellation policy.</p>
                  </div>
                )}
              </section>

              {respond && (
                <section className="space-y-2">
                  <Label htmlFor="dsp-note">Your explanation</Label>
                  <Textarea id="dsp-note" rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was sold, when it was delivered or used, and why the charge is valid." />
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy !== null || note.trim().length < 10 || !(d.evidence ?? []).length} onClick={() => void run('submit', () => api.post(`/v1/disputes/${d.id}/submit`, { note: note.trim() }), 'Submitted for review')}>
                      {busy === 'submit' && <Loader2 className="animate-spin" />} Submit evidence
                    </Button>
                    <Button variant="outline" className="text-destructive" disabled={busy !== null} onClick={() => setAccepting(true)}>
                      Accept dispute
                    </Button>
                  </div>
                </section>
              )}

              {admin && can('dispute.manage') && (d.status === 'OPEN' || d.status === 'UNDER_REVIEW') && (
                <section className="space-y-2 rounded-lg border p-3">
                  <h3 className="text-sm font-semibold">Decision</h3>
                  <p className="text-muted-foreground text-xs">Record what the bank / network decided. Won releases the hold; lost sends it to the provider{' '}and can recover a chargeback fee (+18% GST).</p>
                  <div className="flex gap-2">
                    <Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => setOutcome('WON')}>
                      <CheckCircle2 /> Won
                    </Button>
                    <Button variant="outline" className="text-destructive" onClick={() => setOutcome('LOST')}>
                      <XCircle /> Lost
                    </Button>
                  </div>
                </section>
              )}

              {(d.status === 'WON' || d.status === 'LOST') && (
                <div className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">
                    {d.status === 'WON' ? 'Decided for the merchant — hold released.' : `Decided for the customer — ${inr(d.amount)} debited${d.fee !== '0.00' ? ` + ${inr(d.fee)} fee + ${inr(d.tax)} GST` : ''}.`}
                  </p>
                  {d.resolution_note && <p className="text-muted-foreground mt-1">{d.resolution_note}</p>}
                  {d.resolved_at && <p className="text-muted-foreground mt-1 text-xs">{formatDateTime(d.resolved_at)}</p>}
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
      <ConfirmDialog
        open={accepting}
        onOpenChange={setAccepting}
        title="Accept this dispute?"
        description={d ? `${inr(d.amount)} on hold goes back to the customer and the payment is marked as a chargeback. This can't be undone.` : ''}
        confirmLabel="Accept dispute"
        destructive
        pending={busy === 'accept'}
        onConfirm={() => d && void run('accept', () => api.post(`/v1/disputes/${d.id}/accept`, { note: note.trim() || undefined }), 'Dispute accepted').then(() => setAccepting(false))}
      />
      <Dialog open={outcome !== null} onOpenChange={(o) => !o && setOutcome(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{outcome === 'WON' ? 'Mark as won' : 'Mark as lost'}</DialogTitle>
            <DialogDescription>{outcome === 'WON' ? 'The held amount returns to the merchant.' : 'The disputed amount is debited and returned to the provider.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="dsp-decision-note">Note</Label>
              <Input id="dsp-decision-note" value={decision.note} maxLength={500} onChange={(e) => setDecision((x) => ({ ...x, note: e.target.value }))} placeholder="e.g. Bank accepted delivery proof (case 7788)" />
            </div>
            {outcome === 'LOST' && (
              <div className="space-y-1.5">
                <Label htmlFor="dsp-fee">Chargeback fee (₹, optional)</Label>
                <Input id="dsp-fee" inputMode="decimal" value={decision.fee} onChange={(e) => setDecision((x) => ({ ...x, fee: e.target.value.replace(/[^\d.]/g, '') }))} placeholder="0.00 — 18% GST is added" />
              </div>
            )}
            <Button
              className="w-full"
              disabled={decision.note.trim().length < 5 || busy !== null}
              onClick={() =>
                d &&
                void run(
                  'resolve',
                  () => api.post(`/v1/admin/disputes/${d.id}/resolve`, { outcome, note: decision.note.trim(), ...(outcome === 'LOST' && decision.fee ? { fee: Number(decision.fee).toFixed(2) } : {}) }),
                  outcome === 'WON' ? 'Dispute won — hold released' : 'Dispute lost — amount debited',
                ).then(() => {
                  setOutcome(null);
                  setDecision({ note: '', fee: '' });
                })
              }
            >
              {busy === 'resolve' && <Loader2 className="animate-spin" />} Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}

function OpenDisputeDialog({ open, onOpenChange, onOpened }: { open: boolean; onOpenChange: (o: boolean) => void; onOpened: (id: string) => void }) {
  const qc = useQueryClient();
  const blank = { payment: '', amount: '', code: '', reason: '', days: '7', caseId: '' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const valid = /^pay_[0-9A-Z]{26}$/.test(f.payment.trim()) && f.code.trim() && f.reason.trim().length >= 5 && (!f.amount || Number(f.amount) >= 1);
  async function submit() {
    setBusy(true);
    try {
      const d = await api.post<DisputeRow>('/v1/admin/disputes', {
        payment_id: f.payment.trim(),
        reason_code: f.code.trim(),
        reason: f.reason.trim(),
        respond_by_days: Number(f.days),
        ...(f.amount ? { amount: Number(f.amount).toFixed(2) } : {}),
        ...(f.caseId.trim() ? { provider_case_id: f.caseId.trim() } : {}),
      });
      toast.success('Dispute opened — the amount is on hold and the merchant was notified');
      setF(blank);
      onOpenChange(false);
      onOpened(d.id);
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Open a dispute</DialogTitle>
          <DialogDescription>From a bank / network chargeback notice. The amount is frozen in the merchant&apos;s balance until you decide it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="od-payment">Payment id</Label>
            <Input id="od-payment" value={f.payment} onChange={(e) => set('payment', e.target.value)} placeholder="pay_01J…" className="font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="od-code">Reason code</Label>
              <Input id="od-code" value={f.code} maxLength={40} onChange={(e) => set('code', e.target.value)} placeholder="e.g. 13.1" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="od-amount">
                Amount <span className="text-muted-foreground font-normal">(blank = full)</span>
              </Label>
              <Input id="od-amount" inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value.replace(/[^\d.]/g, ''))} placeholder="₹" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="od-reason">Customer&apos;s claim</Label>
            <Input id="od-reason" value={f.reason} maxLength={500} onChange={(e) => set('reason', e.target.value)} placeholder="Goods not received" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="od-days">Merchant has (days)</Label>
              <Input id="od-days" inputMode="numeric" value={f.days} onChange={(e) => set('days', e.target.value.replace(/\D/g, '').slice(0, 2))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="od-case">Bank case no. (optional)</Label>
              <Input id="od-case" value={f.caseId} maxLength={80} onChange={(e) => set('caseId', e.target.value)} />
            </div>
          </div>
          <Button className="w-full" disabled={!valid || busy || !(Number(f.days) >= 1 && Number(f.days) <= 30)} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />} Open dispute and hold funds
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
