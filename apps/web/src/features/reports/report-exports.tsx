'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, apiDownload } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { ReportExport } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

const TYPES: { id: ReportExport['type']; label: string; statuses: string[] }[] = [
  { id: 'PAYMENTS', label: 'Payins', statuses: ['SUCCESS', 'FAILED', 'PENDING', 'EXPIRED', 'SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
  { id: 'REFUNDS', label: 'Refunds', statuses: ['SUCCESS', 'FAILED', 'PENDING', 'MANUAL_REVIEW'] },
  { id: 'PAYOUTS', label: 'Payouts', statuses: ['SUCCESS', 'FAILED', 'REJECTED', 'REVERSED', 'PENDING', 'QUEUED', 'MANUAL_REVIEW'] },
  { id: 'SETTLEMENTS', label: 'Settlements', statuses: ['PROCESSED', 'PROCESSING', 'FAILED'] },
  { id: 'LOGIN_EVENTS', label: 'Login activity', statuses: ['SUCCESS', 'BAD_PASSWORD', 'MFA_FAILED', 'LOCKED', 'UNKNOWN_USER'] },
];
const label = (t: ReportExport['type']) => TYPES.find((x) => x.id === t)?.label ?? t;

/** Today in IST as YYYY-MM-DD (reports use IST calendar days). */
function istDay(offsetDays = 0) {
  return new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function size(bytes: number | null) {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function RequestForm({ allowMerchantFilter }: { allowMerchantFilter: boolean }) {
  const qc = useQueryClient();
  const [type, setType] = useState<ReportExport['type']>('PAYMENTS');
  const [from, setFrom] = useState(istDay(-6));
  const [to, setTo] = useState(istDay());
  const [status, setStatus] = useState('ALL');
  const [merchant, setMerchant] = useState('');
  const [busy, setBusy] = useState(false);
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  const merchantOk = !merchant || /^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(merchant.trim());
  const valid = Boolean(from && to) && days >= 1 && days <= 92 && merchantOk;
  async function submit() {
    setBusy(true);
    try {
      await api.post('/v1/reports/exports', { type, from, to, ...(status !== 'ALL' ? { status } : {}), ...(merchant.trim() ? { merchant_id: merchant.trim() } : {}) });
      toast.success('Export queued — it will appear below when ready');
      await qc.invalidateQueries({ queryKey: ['report-exports'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">New export</CardTitle>
        <CardDescription>CSV, generated in the background. Dates are IST calendar days; up to 92 days and 1,000,000 rows per export. Files are kept for 7 days.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="space-y-1.5">
            <Label>Report</Label>
            <Select value={type} onValueChange={(v) => { setType(v as ReportExport['type']); setStatus('ALL'); }}>
              <SelectTrigger aria-label="Report type"><SelectValue /></SelectTrigger>
              <SelectContent>{TYPES.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="rx-from">From</Label><Input id="rx-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rx-to">To</Label><Input id="rx-to" type="date" value={to} min={from} max={istDay()} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger aria-label="Status filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {TYPES.find((t) => t.id === type)!.statuses.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {allowMerchantFilter && (
            <div className="space-y-1.5"><Label htmlFor="rx-m">Merchant ID (optional)</Label><Input id="rx-m" className="font-mono text-xs" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="org_…" /></div>
          )}
          <div className="flex items-end">
            <Button className="w-full" disabled={!valid || busy} onClick={() => void submit()}>{busy ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />} Request export</Button>
          </div>
        </div>
        {days > 92 && <p className="text-destructive mt-2 text-xs">Choose at most 92 days.</p>}
      </CardContent>
    </Card>
  );
}

export function ReportExports({ allowMerchantFilter = false }: { allowMerchantFilter?: boolean }) {
  const can = useCan();
  const pager = useCursorPagination();
  const query = { limit: 25, cursor: pager.cursor };
  const exports = useQuery({
    queryKey: ['report-exports', query],
    queryFn: () => api.list<ReportExport>('/v1/reports/exports', query),
    placeholderData: keepPreviousData,
    // Poll while anything is still being generated.
    refetchInterval: (q) => (q.state.data?.data.some((e) => e.status === 'QUEUED' || e.status === 'RUNNING') ? 3_000 : false),
  });
  const [downloading, setDownloading] = useState<string | null>(null);
  async function download(e: ReportExport) {
    setDownloading(e.export_id);
    try {
      await apiDownload(`/v1/reports/exports/${e.export_id}/download`, `pay2all-${e.type.toLowerCase()}.csv`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(null);
    }
  }
  return (
    <div className="space-y-6">
      {can('report.export') && <RequestForm allowMerchantFilter={allowMerchantFilter} />}
      <DataTable
        rows={exports.data?.data}
        loading={exports.isFetching}
        error={toTableError(exports.error)}
        rowKey={(e) => e.export_id}
        empty={{ title: 'No exports yet', description: 'Requested exports appear here with their status.' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(exports.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(exports.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        columns={[
          { id: 'report', header: 'Report', cell: (e) => <div className="space-y-0.5"><p className="font-medium">{label(e.type)}</p><p className="text-muted-foreground text-xs">{e.filters.from} → {e.filters.to}{e.filters.status ? ` · ${e.filters.status.toLowerCase()}` : ''}{e.filters.merchant_id ? ` · ${e.filters.merchant_id}` : ''}</p></div> },
          { id: 'requested', header: 'Requested', cell: (e) => <span className="text-sm whitespace-nowrap">{formatDateTime(e.created_at)}</span> },
          { id: 'status', header: 'Status', className: 'whitespace-normal', cell: (e) => <div className="space-y-0.5"><StatusBadge status={e.status === 'RUNNING' ? 'PROCESSING' : e.status} />{e.error && <p className="text-destructive max-w-xs text-xs">{e.error}</p>}</div> },
          { id: 'rows', header: 'Rows', align: 'right', cell: (e) => <span className="tabular text-sm">{e.row_count === null ? '—' : e.row_count.toLocaleString('en-IN')}</span> },
          { id: 'size', header: 'Size', align: 'right', cell: (e) => <span className="tabular text-muted-foreground text-sm">{size(e.file_size)}</span> },
          { id: 'expires', header: 'Available until', cell: (e) => <span className="text-muted-foreground text-sm whitespace-nowrap">{e.expires_at && e.status === 'COMPLETED' ? formatDateTime(e.expires_at) : '—'}</span> },
          {
            id: 'dl',
            header: '',
            align: 'right',
            cell: (e) =>
              e.downloadable && can('report.export') ? (
                <Button size="sm" variant="outline" disabled={downloading === e.export_id} onClick={() => void download(e)}>
                  {downloading === e.export_id ? <Loader2 className="animate-spin" /> : <Download />} CSV
                </Button>
              ) : null,
          },
        ]}
      />
    </div>
  );
}
