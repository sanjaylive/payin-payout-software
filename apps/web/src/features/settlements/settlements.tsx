'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { TransactionDetailsDrawer } from '@pay2all/ui/components/details-drawer';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Landmark, Loader2, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { fmt } from '@/features/ledger/format';
import { api, apiDownload } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { SettlementRow } from '@/lib/api/types';
import { useCan, useMe } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

export const DESTINATION_LABEL = { WALLET: 'Payout wallet', BANK: 'Bank account' } as const;

function OutcomeDialog({ s, mode, onClose }: { s: SettlementRow; mode: 'paid' | 'failed' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [utr, setUtr] = useState('');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = mode === 'paid' ? /^[A-Za-z0-9]{6,40}$/.test(utr) : reason.trim().length >= 5;
  async function submit() {
    setBusy(true);
    try {
      if (mode === 'paid') await api.post(`/v1/settlements/${s.settlement_id}/paid`, { utr, ...(ref ? { bank_reference: ref } : {}) });
      else await api.post(`/v1/settlements/${s.settlement_id}/failed`, { reason: reason.trim() });
      toast.success(mode === 'paid' ? 'Settlement marked paid' : 'Settlement failed — funds returned to unsettled');
      await qc.invalidateQueries({ queryKey: ['settlements'] });
      await qc.invalidateQueries({ queryKey: ['settlement', s.settlement_id] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={mode !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'paid' ? 'Confirm bank transfer' : 'Mark transfer failed'}</DialogTitle>
          <DialogDescription>
            {mode === 'paid' ? `Record the UTR for the ${fmt(s.net)} transfer to ${s.bank?.account_number_masked ?? 'the merchant'}. This posts the settlement to the ledger.` : 'The funds go back to the merchant’s unsettled balance and the payments are settled again in the next run.'}
          </DialogDescription>
        </DialogHeader>
        {mode === 'paid' ? (
          <div className="space-y-3">
            <div className="space-y-1.5"><Label htmlFor="stl-utr">UTR</Label><Input id="stl-utr" className="font-mono" value={utr} onChange={(e) => setUtr(e.target.value.trim())} /></div>
            <div className="space-y-1.5"><Label htmlFor="stl-ref">Bank reference (optional)</Label><Input id="stl-ref" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          </div>
        ) : (
          <div className="space-y-1.5"><Label htmlFor="stl-reason">Reason</Label><Textarea id="stl-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Beneficiary bank returned: account frozen" /></div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={mode === 'failed' ? 'destructive' : 'default'} disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} {mode === 'paid' ? 'Mark paid' : 'Mark failed'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettlementDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const can = useCan();
  const { data: me } = useMe();
  const s = useQuery({ queryKey: ['settlement', id], queryFn: () => api.get<SettlementRow>(`/v1/settlements/${id}`), enabled: Boolean(id) });
  const [mode, setMode] = useState<'paid' | 'failed' | null>(null);
  const row = s.data;
  const finance = me?.organization.type === 'PLATFORM' && can('settlement.process');
  return (
    <>
      <TransactionDetailsDrawer
        open={Boolean(id)}
        onOpenChange={(o) => !o && onClose()}
        title={row ? <span className="flex items-center gap-2">{fmt(row.net)} <StatusBadge status={row.status} /></span> : 'Settlement'}
        subtitle={row && <span className="font-mono text-xs">{row.settlement_id}</span>}
        sections={
          row
            ? [
                {
                  title: 'Settlement',
                  fields: [
                    { label: 'Date', value: `${row.settlement_date} (${row.cycle})` },
                    { label: 'Covers', value: `Payments captured ${row.period_start ? `from ${formatDateTime(row.period_start)} ` : ''}until ${formatDateTime(row.period_end)}` },
                    { label: 'Destination', value: row.destination === 'BANK' && row.bank ? `${row.bank.account_number_masked} · ${row.bank.ifsc}${row.bank.bank_name ? ` · ${row.bank.bank_name}` : ''}` : DESTINATION_LABEL[row.destination] },
                    { label: 'UTR', value: row.utr, mono: true },
                    ...(row.failure_reason ? [{ label: 'Failure', value: row.failure_reason }] : []),
                    ...(row.processed_at ? [{ label: 'Completed', value: formatDateTime(row.processed_at) }] : []),
                  ],
                },
                {
                  title: 'Breakdown',
                  fields: [
                    { label: 'Payments', value: String(row.payment_count) },
                    { label: 'Gross collected', value: fmt(row.gross) },
                    { label: 'Fees', value: fmt(row.fees) },
                    { label: 'GST on fees', value: fmt(row.tax) },
                    { label: 'Refunds on these', value: fmt(row.refunds) },
                    { label: 'Settled', value: <span className="font-medium">{fmt(row.net)}</span> },
                  ],
                },
              ]
            : []
        }
      >
        {row && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-xs">The settled amount is your unsettled balance minus what newer payments still need; refunds already taken from it are therefore reflected, and nothing is settled twice.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void apiDownload(`/v1/settlements/${row.settlement_id}/statement`, `settlement-${row.settlement_date}.csv`).catch((e: unknown) => toast.error(errorMessage(e)))}><Download /> Statement (CSV)</Button>
              {finance && row.status === 'PROCESSING' && (
                <>
                  <Button size="sm" onClick={() => setMode('paid')}><Check /> Mark paid</Button>
                  <Button size="sm" variant="outline" onClick={() => setMode('failed')}><X /> Mark failed</Button>
                </>
              )}
            </div>
            {(row.payments?.length ?? 0) > 0 && (
              <section>
                <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">Payments</h4>
                <ul className="divide-y rounded-lg border text-sm">
                  {row.payments!.slice(0, 50).map((p) => (
                    <li key={p.payment_id} className="flex justify-between gap-3 px-3 py-2">
                      <div><p className="font-mono text-xs">{p.merchant_order_id}</p><p className="text-muted-foreground text-[11px]">{formatDateTime(p.success_at)}{p.refunded !== '0.00' ? ` · refunded ${fmt(p.refunded)}` : ''}</p></div>
                      <span className="tabular">{fmt(p.net)}</span>
                    </li>
                  ))}
                </ul>
                {row.payments!.length > 50 && <p className="text-muted-foreground mt-1 text-xs">Showing 50 of {row.payments!.length}; download the statement for all.</p>}
              </section>
            )}
          </div>
        )}
      </TransactionDetailsDrawer>
      {row && <OutcomeDialog s={row} mode={mode} onClose={() => setMode(null)} />}
    </>
  );
}

export function SettlementsTable({ internal = false, status }: { internal?: boolean; status?: SettlementRow['status'] }) {
  const pager = useCursorPagination();
  const [filter, setFilter] = useState<string>(status ?? 'ALL');
  const [selected, setSelected] = useState<string | null>(null);
  const query = { limit: 25, cursor: pager.cursor, status: filter === 'ALL' ? undefined : filter };
  const list = useQuery({ queryKey: ['settlements', query], queryFn: () => api.list<SettlementRow>('/v1/settlements', query), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  return (
    <>
      <DataTable
        rows={list.data?.data}
        loading={list.isFetching}
        error={toTableError(list.error)}
        onRetry={() => void list.refetch()}
        rowKey={(s) => s.settlement_id}
        onRowClick={(s) => setSelected(s.settlement_id)}
        empty={{ title: 'No settlements yet', description: 'Successful payments are settled on your schedule after the daily cutoff.' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(list.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(list.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        toolbar={
          <Select value={filter} onValueChange={(v) => { setFilter(v); pager.reset(); }}>
            <SelectTrigger className="w-44" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              <SelectItem value="PROCESSING">In transit</SelectItem>
              <SelectItem value="PROCESSED">Processed</SelectItem>
              <SelectItem value="FAILED">Failed</SelectItem>
            </SelectContent>
          </Select>
        }
        columns={[
          { id: 'date', header: 'Date', cell: (s) => <div><p className="text-sm font-medium">{s.settlement_date}</p><p className="text-muted-foreground text-xs">{s.cycle} · {s.payment_count} payments</p></div> },
          ...(internal ? [{ id: 'merchant', header: 'Merchant', cell: (s: SettlementRow) => <span className="font-mono text-xs">{s.merchant_id}</span> }] : []),
          { id: 'dest', header: 'To', cell: (s) => <span className="flex items-center gap-1.5 text-sm">{s.destination === 'BANK' ? <Landmark className="size-4" /> : <Wallet className="size-4" />}{s.destination === 'BANK' ? (s.bank?.account_number_masked ?? 'Bank') : 'Wallet'}</span> },
          { id: 'status', header: 'Status', cell: (s) => <div className="space-y-0.5"><StatusBadge status={s.status} />{s.utr && <p className="text-muted-foreground font-mono text-[11px]">{s.utr}</p>}</div> },
          { id: 'gross', header: 'Gross', align: 'right', cell: (s) => <span className="tabular text-muted-foreground text-sm">{fmt(s.gross)}</span> },
          { id: 'net', header: 'Settled', align: 'right', cell: (s) => <span className="tabular font-medium">{fmt(s.net)}</span> },
        ]}
      />
      <SettlementDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
