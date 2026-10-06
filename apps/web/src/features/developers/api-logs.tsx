'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Activity, CircleAlert, Gauge } from 'lucide-react';
import { useState } from 'react';
import { ColumnChart } from '@/features/payin/column-chart';
import { api } from '@/lib/api/client';
import { toTableError } from '@/lib/api/errors';
import type { ApiLogRow, ApiUsage } from '@/lib/api/types';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

export function ApiUsageOverview() {
  const [days, setDays] = useState('7');
  const usage = useQuery({ queryKey: ['api-usage', days], queryFn: () => api.get<ApiUsage>('/v1/developers/api-usage', { days }) });
  const u = usage.data;
  const p95 = u?.daily.length ? Math.max(...u.daily.map((d) => d.p95_ms ?? 0)) : null;
  const data = (u?.daily ?? []).map((d) => {
    const day = new Date(d.day);
    return { label: day.toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' }), title: day.toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }), values: { ok: d.requests - d.errors, errors: d.errors } };
  });
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-36" aria-label="Period"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="1">Last 24 hours</SelectItem><SelectItem value="7">Last 7 days</SelectItem><SelectItem value="30">Last 30 days</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="API requests" value={u ? u.totals.requests.toLocaleString('en-IN') : '—'} loading={usage.isPending} icon={Activity} />
        <StatCard label="Error rate" value={u?.totals.error_rate == null ? '—' : `${(u.totals.error_rate * 100).toFixed(1)}%`} loading={usage.isPending} icon={CircleAlert} hint={u ? `${u.totals.errors.toLocaleString('en-IN')} failed requests` : undefined} />
        <StatCard label="Slowest day p95" value={p95 === null ? '—' : `${p95} ms`} loading={usage.isPending} icon={Gauge} hint="Server time, excluding network" />
      </div>
      {data.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="shadow-none lg:col-span-2">
            <CardHeader><CardTitle className="text-base">Requests per day</CardTitle><CardDescription>Successful vs failed (4xx/5xx), IST</CardDescription></CardHeader>
            <CardContent>
              <ColumnChart data={data} series={[{ key: 'ok', label: 'Succeeded', color: 'var(--primary)' }, { key: 'errors', label: 'Failed', color: 'var(--destructive)' }]} formatValue={(v) => Math.round(v).toLocaleString('en-IN')} ariaLabel="API requests per day" integer />
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader><CardTitle className="text-base">Top errors</CardTitle></CardHeader>
            <CardContent>
              {u?.top_errors.length ? (
                <ul className="space-y-1 text-sm">{u.top_errors.map((e) => <li key={e.code} className="flex justify-between"><span className="font-mono text-xs">{e.code}</span><span className="tabular">{e.count}</span></li>)}</ul>
              ) : (
                <p className="text-muted-foreground text-sm">No errors in this period.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

export function ApiLogsTable() {
  const pager = useCursorPagination();
  const [status, setStatus] = useState('ALL');
  const query = { limit: 50, cursor: pager.cursor, status: status === 'ALL' ? undefined : status };
  const logs = useQuery({ queryKey: ['api-logs', query], queryFn: () => api.list<ApiLogRow>('/v1/developers/api-logs', query), placeholderData: keepPreviousData, refetchInterval: 10_000 });
  return (
    <DataTable
      rows={logs.data?.data}
      loading={logs.isFetching}
      error={toTableError(logs.error)}
      rowKey={(l) => l.id}
      empty={{ title: 'No API requests yet' }}
      pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(logs.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(logs.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
      toolbar={
        <Select value={status} onValueChange={(v) => { setStatus(v); pager.reset(); }}>
          <SelectTrigger className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="ALL">All</SelectItem><SelectItem value="2xx">2xx</SelectItem><SelectItem value="4xx">4xx</SelectItem><SelectItem value="5xx">5xx</SelectItem></SelectContent>
        </Select>
      }
      columns={[
        { id: 'time', header: 'Time', cell: (l) => <span className="text-sm whitespace-nowrap">{formatDateTime(l.created_at)}</span> },
        { id: 'req', header: 'Request', cell: (l) => <span className="font-mono text-xs"><span className="font-semibold">{l.method}</span> {l.path}</span> },
        { id: 'status', header: 'Status', cell: (l) => <div className="space-y-0.5"><StatusBadge status={String(l.status_code)} tone={l.status_code < 300 ? 'success' : l.status_code < 500 ? 'warning' : 'danger'} />{l.error_code && <p className="text-muted-foreground font-mono text-[11px]">{l.error_code}</p>}</div> },
        { id: 'ip', header: 'From', cell: (l) => <span className="font-mono text-xs">{l.ip_address ?? '—'}</span> },
        { id: 'rid', header: 'Request ID', cell: (l) => <span className="text-muted-foreground font-mono text-[11px]">{l.request_id}</span> },
        { id: 'ms', header: 'Time (ms)', align: 'right', cell: (l) => <span className="tabular text-sm">{l.duration_ms}</span> },
      ]}
    />
  );
}
