'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { TransactionDetailsDrawer } from '@pay2all/ui/components/details-drawer';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { WebhookDeliveryRow } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

function DeliveryDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const d = useQuery({ queryKey: ['webhook-delivery', id], queryFn: () => api.get<WebhookDeliveryRow>(`/v1/webhooks/deliveries/${id}`), enabled: Boolean(id), refetchInterval: (q) => (q.state.data?.status === 'PENDING' ? 3_000 : false) });
  const row = d.data;
  async function replay() {
    setBusy(true);
    try {
      await api.post(`/v1/webhooks/deliveries/${id}/retry`);
      toast.success('Delivery queued again');
      await qc.invalidateQueries({ queryKey: ['webhook-delivery', id] });
      await qc.invalidateQueries({ queryKey: ['webhook-deliveries'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <TransactionDetailsDrawer
      open={Boolean(id)}
      onOpenChange={(o) => !o && onClose()}
      title={row ? <span className="flex items-center gap-2 font-mono text-base">{row.event_type} <StatusBadge status={row.status} /></span> : 'Delivery'}
      subtitle={row && <span className="font-mono text-xs">{row.delivery_id}</span>}
      sections={
        row
          ? [
              {
                title: 'Delivery',
                fields: [
                  { label: 'Endpoint', value: row.endpoint_url, mono: true },
                  { label: 'Event ID', value: row.event_id, mono: true },
                  { label: 'Created', value: formatDateTime(row.created_at) },
                  { label: 'Attempts', value: String(row.attempts) },
                  ...(row.status === 'PENDING' && row.next_attempt_at ? [{ label: 'Next attempt', value: formatDateTime(row.next_attempt_at) }] : []),
                  ...(row.delivered_at ? [{ label: 'Delivered', value: formatDateTime(row.delivered_at) }] : []),
                ],
              },
            ]
          : []
      }
    >
      {row && (
        <div className="space-y-4">
          {can('webhook.manage') && row.status !== 'PENDING' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void replay()}>{busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Replay delivery</Button>}
          {(row.attempt_log?.length ?? 0) > 0 && (
            <section>
              <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">Attempts</h4>
              <ul className="divide-y rounded-lg border text-sm">
                {row.attempt_log!.map((a) => (
                  <li key={a.attempt_no} className="space-y-1 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">#{a.attempt_no} · {a.status_code ?? 'no response'}</span>
                      <span className="text-muted-foreground text-xs">{formatDateTime(a.created_at)} · {a.duration_ms} ms</span>
                    </div>
                    {a.error && <p className="text-destructive text-xs">{a.error}</p>}
                    {a.response_snippet && <pre className="bg-muted max-h-24 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap">{a.response_snippet}</pre>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">Payload</h4>
            <pre className="bg-muted max-h-80 overflow-auto rounded-lg p-3 text-[11px]">{JSON.stringify(row.payload, null, 2)}</pre>
          </section>
        </div>
      )}
    </TransactionDetailsDrawer>
  );
}

export function DeliveryLog({ internal = false }: { internal?: boolean }) {
  const pager = useCursorPagination();
  const [status, setStatus] = useState('ALL');
  const [selected, setSelected] = useState<string | null>(null);
  const query = { limit: 25, cursor: pager.cursor, status: status === 'ALL' ? undefined : status };
  const list = useQuery({ queryKey: ['webhook-deliveries', query], queryFn: () => api.list<WebhookDeliveryRow>('/v1/webhooks/deliveries', query), placeholderData: keepPreviousData, refetchInterval: 10_000 });
  return (
    <>
      <DataTable
        rows={list.data?.data}
        loading={list.isFetching}
        error={toTableError(list.error)}
        onRetry={() => void list.refetch()}
        rowKey={(d) => d.delivery_id}
        onRowClick={(d) => setSelected(d.delivery_id)}
        empty={{ title: 'No deliveries yet', description: 'Deliveries appear here once an endpoint is configured and events occur.' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(list.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(list.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        toolbar={
          <Select value={status} onValueChange={(v) => { setStatus(v); pager.reset(); }}>
            <SelectTrigger className="w-40" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All deliveries</SelectItem>
              <SelectItem value="PENDING">Pending / retrying</SelectItem>
              <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
              <SelectItem value="FAILED">Failed</SelectItem>
            </SelectContent>
          </Select>
        }
        columns={[
          { id: 'time', header: 'Created', cell: (d) => <span className="text-sm whitespace-nowrap">{formatDateTime(d.created_at)}</span> },
          { id: 'type', header: 'Event', cell: (d) => <div><p className="font-mono text-xs">{d.event_type}</p><p className="text-muted-foreground font-mono text-[11px]">{d.event_id}</p></div> },
          ...(internal ? [{ id: 'merchant', header: 'Merchant', cell: (d: WebhookDeliveryRow) => <span className="font-mono text-xs">{d.merchant_id}</span> }] : []),
          { id: 'endpoint', header: 'Endpoint', cell: (d) => <span className="font-mono text-xs break-all">{d.endpoint_url}</span> },
          { id: 'status', header: 'Status', cell: (d) => <div className="space-y-0.5"><StatusBadge status={d.status} />{d.last_error && <p className="text-muted-foreground text-[11px]">{d.last_error}</p>}</div> },
          { id: 'attempts', header: 'Attempts', align: 'right', cell: (d) => <span className="tabular text-sm">{d.attempts}{d.last_status_code ? ` · ${d.last_status_code}` : ''}</span> },
        ]}
      />
      <DeliveryDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
