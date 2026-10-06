'use client';

import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileUp, Loader2, Send, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { fmt } from '@/features/ledger/format';
import { api, apiUpload } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { BulkBatch } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { statusLabel } from './labels';
import { PayoutsTable } from './payouts-table';

const TEMPLATE = [
  'merchant_order_id,amount,mode,beneficiary_name,account_number,ifsc,upi_id,purpose,narration',
  'SAL-OCT-001,25000.00,IMPS,Ravi Kumar,50100123456781,HDFC0001234,,SALARY,October salary',
  'SAL-OCT-002,18000.00,UPI,Meera Iyer,,,meera@okaxis,SALARY,October salary',
].join('\n');

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'pay2all-bulk-payout-template.csv' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BatchDetail({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const batch = useQuery({
    queryKey: ['bulk-batch', batchId],
    queryFn: () => api.get<BulkBatch>(`/v1/payouts/bulk/${batchId}`),
    refetchInterval: (q) => (q.state.data && ['CONFIRMED', 'PROCESSING'].includes(q.state.data.status) ? 3_000 : false),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const b = batch.data;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['bulk-batch', batchId] });
    await qc.invalidateQueries({ queryKey: ['bulk-batches'] });
    await qc.invalidateQueries({ queryKey: ['payouts'] });
  };
  async function act(path: string, label: string, body?: unknown) {
    setBusy(path);
    try {
      const r = await api.post<BulkBatch | { decided: number; failed: unknown[] }>(`/v1/payouts/bulk/${batchId}/${path}`, body ?? {});
      toast.success('decided' in r ? `${label}: ${r.decided} payout${r.decided === 1 ? '' : 's'}` : label);
      setRejecting(false);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  if (!b) return null;
  const created = b.status === 'PROCESSING' || b.status === 'COMPLETED';
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span>{b.file_name}</span>
          <StatusBadge status={b.status} />
        </CardTitle>
        <CardDescription>
          {b.valid_rows}/{b.total_rows} valid rows · {fmt(b.total_amount)} · uploaded {formatDateTime(b.created_at)}
          {b.status !== 'VALIDATED' && b.status !== 'VALIDATION_FAILED' && ` · each row needs ${b.approvals_required} approval${b.approvals_required === 1 ? '' : 's'}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {b.status === 'VALIDATED' && can('payout.create') && (
            <Button disabled={busy !== null} onClick={() => void act('confirm', 'Batch confirmed — creating payouts')}>{busy === 'confirm' ? <Loader2 className="animate-spin" /> : <Send />} Confirm {b.valid_rows} payouts</Button>
          )}
          {(b.status === 'VALIDATED' || b.status === 'VALIDATION_FAILED') && <Button variant="outline" disabled={busy !== null} onClick={() => void act('cancel', 'Batch cancelled')}>Discard</Button>}
          {created && can('payout.approve') && (
            <>
              <Button disabled={busy !== null} onClick={() => void act('approve', 'Approved')}>{busy === 'approve' ? <Loader2 className="animate-spin" /> : <Check />} Approve all I can</Button>
              <Button variant="outline" disabled={busy !== null} onClick={() => setRejecting(true)}><X /> Reject all pending</Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>Back to batches</Button>
        </div>
        {b.status === 'VALIDATION_FAILED' && <p className="text-destructive text-sm">Fix the rows marked invalid and upload the corrected file. Nothing has been paid.</p>}
        {b.status === 'VALIDATED' && <p className="text-muted-foreground text-sm">Confirming needs two-factor authentication. Each row reserves its amount + fee when it is created; if the balance runs out, the remaining rows are not created.</p>}
        {created ? (
          <PayoutsTable batchId={b.batch_id} />
        ) : (
          <DataTable
            rows={b.rows}
            rowKey={(r) => String(r.row_no)}
            error={toTableError(batch.error)}
            columns={[
              { id: 'row', header: '#', cell: (r) => <span className="text-muted-foreground tabular text-xs">{r.row_no}</span> },
              { id: 'order', header: 'Order ID', cell: (r) => <span className="font-mono text-xs">{r.merchant_order_id ?? '—'}</span> },
              { id: 'ben', header: 'Beneficiary', cell: (r) => <span className="font-mono text-xs">{r.beneficiary ?? '—'}</span> },
              { id: 'mode', header: 'Mode', cell: (r) => <span className="text-sm">{r.mode ?? '—'}</span> },
              { id: 'status', header: 'Status', cell: (r) => <div className="space-y-0.5"><StatusBadge status={r.status === 'INVALID' ? 'REJECTED' : r.status === 'VALID' ? 'APPROVED' : r.status} />{r.errors?.map((e) => <p key={e} className="text-destructive text-[11px]">{e}</p>)}</div> },
              { id: 'amount', header: 'Amount', align: 'right', cell: (r) => <span className="tabular">{fmt(r.amount)}</span> },
            ]}
          />
        )}
      </CardContent>
      <ConfirmDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject all pending payouts in this batch?"
        description="Their reserved funds are returned to your available balance."
        confirmLabel="Reject all"
        destructive
        requireReason
        pending={busy !== null}
        onConfirm={(reason) => void act('reject', 'Rejected', { reason })}
      />
    </Card>
  );
}

export function BulkPayouts() {
  const can = useCan();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const batches = useQuery({ queryKey: ['bulk-batches'], queryFn: () => api.get<BulkBatch[]>('/v1/payouts/bulk'), refetchInterval: 10_000 });

  async function upload(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const b = await apiUpload<BulkBatch>('/v1/payouts/bulk', form);
      toast[b.status === 'VALIDATED' ? 'success' : 'error'](b.status === 'VALIDATED' ? `${b.valid_rows} rows ready to confirm` : `${b.total_rows - b.valid_rows} row(s) need fixing`);
      await qc.invalidateQueries({ queryKey: ['bulk-batches'] });
      setOpen(b.batch_id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  if (open) return <BatchDetail batchId={open} onClose={() => setOpen(null)} />;
  return (
    <div className="space-y-6">
      {can('payout.create') && (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Upload a payout file</CardTitle>
            <CardDescription>CSV, up to 1,000 rows and 1 MB. Every row is validated before anything is paid; the file itself is not stored.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <Button disabled={uploading} onClick={() => input.current?.click()}>{uploading ? <Loader2 className="animate-spin" /> : <FileUp />} Choose CSV</Button>
            <Button variant="outline" onClick={downloadTemplate}><Download /> Download template</Button>
          </CardContent>
        </Card>
      )}
      <DataTable
        rows={batches.data}
        loading={batches.isFetching}
        error={toTableError(batches.error)}
        rowKey={(b) => b.batch_id}
        onRowClick={(b) => setOpen(b.batch_id)}
        empty={{ title: 'No bulk uploads yet' }}
        columns={[
          { id: 'file', header: 'File', cell: (b) => <div><p className="font-medium">{b.file_name}</p><p className="text-muted-foreground text-xs">{formatDateTime(b.created_at)}</p></div> },
          { id: 'rows', header: 'Rows', cell: (b) => <span className="text-sm">{b.valid_rows}/{b.total_rows} valid{b.created_count ? ` · ${b.created_count} created` : ''}{b.failed_count ? ` · ${b.failed_count} failed` : ''}</span> },
          { id: 'status', header: 'Status', cell: (b) => <StatusBadge status={b.status} /> },
          { id: 'amount', header: 'Total', align: 'right', cell: (b) => <span className="tabular font-medium">{fmt(b.total_amount)}</span> },
        ]}
      />
      <p className="text-muted-foreground text-xs">Statuses: {['VALIDATED', 'VALIDATION_FAILED', 'CONFIRMED', 'PROCESSING', 'COMPLETED'].map(statusLabel).join(' → ')}</p>
    </div>
  );
}
