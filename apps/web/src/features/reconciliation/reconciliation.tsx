'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileUp, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { fmt } from '@/features/ledger/format';
import { api, apiUpload } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { ProviderRow, ReconEntry, ReconRun } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

const RESULT_LABEL: Record<ReconEntry['result'], string> = {
  MATCHED: 'Matched',
  AMOUNT_MISMATCH: 'Amount mismatch',
  STATUS_MISMATCH: 'Status mismatch',
  MISSING_INTERNAL: 'Not in Pay2All',
  MISSING_PROVIDER: 'Not in statement',
  DUPLICATE: 'Duplicate',
};
const RESULT_TONE: Record<ReconEntry['result'], 'success' | 'danger' | 'warning' | 'neutral'> = { MATCHED: 'success', AMOUNT_MISMATCH: 'danger', STATUS_MISMATCH: 'danger', MISSING_INTERNAL: 'warning', MISSING_PROVIDER: 'warning', DUPLICATE: 'neutral' };

function Upload() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers', 'all'], queryFn: () => api.get<ProviderRow[]>('/v1/providers') });
  const [providerId, setProviderId] = useState('');
  const [kind, setKind] = useState<'PAYIN' | 'PAYOUT'>('PAYIN');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('provider_id', providerId);
      form.append('kind', kind);
      form.append('file', file);
      await apiUpload<ReconRun>('/v1/reconciliation/runs', form);
      toast.success('Statement imported — matching runs in the background');
      await qc.invalidateQueries({ queryKey: ['recon-runs'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Import a provider statement</CardTitle>
        <CardDescription>CSV with columns <code>reference, amount, status, date</code> (optional <code>provider_txn_id, utr, rrn</code>). Stored encrypted; never changes money by itself.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="rc-prov">Provider</Label>
          <Select value={providerId} onValueChange={setProviderId}>
            <SelectTrigger id="rc-prov" className="w-60"><SelectValue placeholder="Choose provider" /></SelectTrigger>
            <SelectContent>{(providers.data ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rc-kind">Statement of</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as 'PAYIN' | 'PAYOUT')}>
            <SelectTrigger id="rc-kind" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="PAYIN">Collections</SelectItem><SelectItem value="PAYOUT">Payouts</SelectItem></SelectContent>
          </Select>
        </div>
        <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <Button disabled={!providerId || busy} onClick={() => input.current?.click()}>{busy ? <Loader2 className="animate-spin" /> : <FileUp />} Choose CSV</Button>
      </CardContent>
    </Card>
  );
}

function ResolveDialog({ entry, onClose }: { entry: ReconEntry | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const canAccept = entry?.result === 'STATUS_MISMATCH' && entry.internal_type === 'PAYMENT' && entry.external_amount === entry.internal_amount && /success|captured|paid|processed|completed|settled/i.test(entry.external_status ?? '');
  async function resolve(action: 'NOTE' | 'ACCEPT_PROVIDER_SUCCESS') {
    if (!entry) return;
    setBusy(true);
    try {
      await api.post(`/v1/reconciliation/entries/${entry.entry_id}/resolve`, { action, note: note.trim() });
      toast.success(action === 'NOTE' ? 'Marked resolved' : 'Payment captured and entry resolved');
      setNote('');
      await qc.invalidateQueries({ queryKey: ['recon-entries'] });
      await qc.invalidateQueries({ queryKey: ['recon-run'] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(entry)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve {entry ? RESULT_LABEL[entry.result].toLowerCase() : ''}</DialogTitle>
          <DialogDescription>
            Statement: {entry?.external_ref ?? '—'} · {entry?.external_status ?? '—'} · {fmt(entry?.external_amount)}. Pay2All: {entry?.internal_id ?? 'no record'} · {entry?.internal_status ?? '—'} · {fmt(entry?.internal_amount)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5"><Label htmlFor="rc-note">Resolution and evidence</Label><Textarea id="rc-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Provider confirmed by email; UTR verified on the bank statement" /></div>
        {canAccept && <p className="text-muted-foreground text-xs">“Accept provider success” captures the payment now through the normal flow (ledger entry, merchant webhook), flagged as a late success.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {canAccept && <Button variant="outline" disabled={note.trim().length < 10 || busy} onClick={() => void resolve('ACCEPT_PROVIDER_SUCCESS')}>Accept provider success</Button>}
          <Button disabled={note.trim().length < 10 || busy} onClick={() => void resolve('NOTE')}>{busy && <Loader2 className="animate-spin" />} Mark resolved</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const can = useCan();
  const pager = useCursorPagination();
  const [result, setResult] = useState('EXCEPTIONS');
  const [resolving, setResolving] = useState<ReconEntry | null>(null);
  const run = useQuery({ queryKey: ['recon-run', runId], queryFn: () => api.get<ReconRun>(`/v1/reconciliation/runs/${runId}`), refetchInterval: (q) => (q.state.data && ['QUEUED', 'PROCESSING'].includes(q.state.data.status) ? 2_000 : false) });
  const query = { limit: 50, cursor: pager.cursor, ...(result === 'EXCEPTIONS' ? { resolution: 'OPEN' } : result === 'ALL' ? {} : { result }) };
  const entries = useQuery({ queryKey: ['recon-entries', runId, query], queryFn: () => api.list<ReconEntry>(`/v1/reconciliation/runs/${runId}/entries`, query), placeholderData: keepPreviousData, enabled: run.data?.status === 'COMPLETED' });
  const r = run.data;
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft /> All runs</Button>
      {r && (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">{r.file_name} <StatusBadge status={r.status} /></CardTitle>
            <CardDescription>{r.provider} · {r.kind === 'PAYIN' ? 'collections' : 'payouts'} · {r.total_rows} rows · imported {formatDateTime(r.created_at)}{r.period_from ? ` · covers ${formatDateTime(r.period_from)} – ${formatDateTime(r.period_to)}` : ''}</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-6">
            {([['Matched', r.matched], ['Mismatched', r.mismatched], ['Not in Pay2All', r.missing_internal], ['Not in statement', r.missing_provider], ['Duplicates', r.duplicates], ['Open items', r.open_items ?? 0]] as const).map(([label, n]) => (
              <div key={label}><p className="text-muted-foreground text-xs">{label}</p><p className="tabular text-lg font-semibold">{n}</p></div>
            ))}
            {r.error && <p className="text-destructive col-span-full text-sm">{r.error}</p>}
          </CardContent>
        </Card>
      )}
      <DataTable
        rows={entries.data?.data}
        loading={entries.isFetching || run.data?.status !== 'COMPLETED'}
        error={toTableError(entries.error)}
        rowKey={(e) => e.entry_id}
        onRowClick={(e) => can('reconciliation.manage') && e.resolution === 'OPEN' && setResolving(e)}
        empty={{ title: result === 'EXCEPTIONS' ? 'No open exceptions' : 'No entries' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(entries.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(entries.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        toolbar={
          <Select value={result} onValueChange={(v) => { setResult(v); pager.reset(); }}>
            <SelectTrigger className="w-52" aria-label="Show"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="EXCEPTIONS">Open exceptions</SelectItem>
              <SelectItem value="ALL">All rows</SelectItem>
              {Object.entries(RESULT_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
        }
        columns={[
          { id: 'line', header: 'Line', cell: (e) => <span className="text-muted-foreground tabular text-xs">{e.line_no ?? '—'}</span> },
          { id: 'result', header: 'Result', cell: (e) => <StatusBadge status={RESULT_LABEL[e.result]} tone={RESULT_TONE[e.result]} /> },
          { id: 'ext', header: 'Statement', cell: (e) => <div><p className="font-mono text-xs">{e.external_ref ?? '—'}</p><p className="text-muted-foreground text-[11px]">{e.external_status ?? ''} {e.external_amount ? fmt(e.external_amount) : ''}</p></div> },
          { id: 'int', header: 'Pay2All', cell: (e) => <div><p className="font-mono text-xs">{e.internal_id ?? '—'}</p><p className="text-muted-foreground text-[11px]">{e.internal_status ?? ''} {e.internal_amount ? fmt(e.internal_amount) : ''}</p></div> },
          { id: 'res', header: 'Resolution', cell: (e) => (e.resolution === 'RESOLVED' ? <p className="text-xs">{e.resolution_note}</p> : e.resolution === 'OPEN' ? <StatusBadge status="OPEN" tone="warning" /> : <span className="text-muted-foreground text-xs">—</span>) },
        ]}
      />
      <ResolveDialog entry={resolving} onClose={() => setResolving(null)} />
    </div>
  );
}

export function Reconciliation() {
  const can = useCan();
  const [open, setOpen] = useState<string | null>(null);
  const runs = useQuery({ queryKey: ['recon-runs'], queryFn: () => api.get<ReconRun[]>('/v1/reconciliation/runs'), refetchInterval: 5_000 });
  if (open) return <RunDetail runId={open} onBack={() => setOpen(null)} />;
  return (
    <div className="space-y-6">
      {can('reconciliation.manage') && <Upload />}
      <DataTable
        rows={runs.data}
        loading={runs.isFetching}
        error={toTableError(runs.error)}
        rowKey={(r) => r.run_id}
        onRowClick={(r) => setOpen(r.run_id)}
        empty={{ title: 'No statements imported yet' }}
        columns={[
          { id: 'when', header: 'Imported', cell: (r) => <span className="text-sm whitespace-nowrap">{formatDateTime(r.created_at)}</span> },
          { id: 'file', header: 'Statement', cell: (r) => <div><p className="text-sm font-medium">{r.file_name}</p><p className="text-muted-foreground text-xs">{r.provider} · {r.kind === 'PAYIN' ? 'collections' : 'payouts'}</p></div> },
          { id: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { id: 'rows', header: 'Rows', align: 'right', cell: (r) => <span className="tabular text-sm">{r.total_rows}</span> },
          { id: 'exceptions', header: 'Exceptions', align: 'right', cell: (r) => <span className="tabular text-sm font-medium">{r.mismatched + r.missing_internal + r.missing_provider + r.duplicates}</span> },
        ]}
      />
    </div>
  );
}
