'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Button } from '@pay2all/ui/components/ui/button';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, Mail, RotateCcw, Send, Skull, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { DeadLetterRow, PipelineHealth } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';

const age = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

export function PipelineOverview() {
  const health = useQuery({ queryKey: ['pipeline-health'], queryFn: () => api.get<PipelineHealth>('/v1/system/events/health'), refetchInterval: 10_000 });
  const h = health.data;
  const loading = health.isPending;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Outbox backlog" value={h ? h.outbox_backlog.toLocaleString('en-IN') : '—'} loading={loading} icon={Inbox} hint={h ? (h.outbox_backlog ? `Oldest waiting ${age(h.outbox_oldest_age_seconds)}` : 'All events published') : undefined} />
      <StatCard label="Open dead letters" value={h ? h.dead_letters_open.toLocaleString('en-IN') : '—'} loading={loading} icon={Skull} hint="Events a consumer gave up on" />
      <StatCard label="Webhooks pending" value={h ? h.webhook_deliveries_pending.toLocaleString('en-IN') : '—'} loading={loading} icon={Send} hint={h ? `${h.webhook_deliveries_failed_24h} failed in 24 h · ${h.webhook_endpoints_auto_disabled} endpoints auto-disabled` : undefined} />
      <StatCard label="Emails queued" value={h ? h.notifications_queued.toLocaleString('en-IN') : '—'} loading={loading} icon={Mail} hint="Waiting for the notification worker" />
    </div>
  );
}

export function DeadLetters() {
  const can = useCan();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['dead-letters'], queryFn: () => api.get<DeadLetterRow[]>('/v1/system/events/dead-letters'), refetchInterval: 15_000 });
  async function requeue(id: string) {
    setBusy(id);
    try {
      await api.post(`/v1/system/events/dead-letters/${id}/requeue`);
      toast.success('Requeued through the outbox');
      await qc.invalidateQueries({ queryKey: ['dead-letters'] });
      await qc.invalidateQueries({ queryKey: ['pipeline-health'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <DataTable
      rows={list.data}
      loading={list.isFetching}
      error={toTableError(list.error)}
      rowKey={(d) => d.id}
      empty={{ title: 'No dead letters', description: 'Every consumed event was processed.' }}
      columns={[
        { id: 'time', header: 'Failed', cell: (d) => <span className="text-sm whitespace-nowrap">{formatDateTime(d.created_at)}</span> },
        { id: 'consumer', header: 'Consumer', cell: (d) => <div><p className="text-sm font-medium">{d.consumer_group}</p><p className="text-muted-foreground font-mono text-[11px]">{d.topic} · p{d.partition} · @{d.offset}</p></div> },
        { id: 'event', header: 'Event', cell: (d) => <div><p className="font-mono text-xs">{d.event_type ?? 'unparseable'}</p><p className="text-muted-foreground font-mono text-[11px]">{d.aggregate_id}</p></div> },
        { id: 'error', header: 'Error', cell: (d) => <p className="text-destructive flex items-start gap-1 text-xs"><TriangleAlert className="mt-0.5 size-3 shrink-0" />{d.error} ({d.attempts} attempts)</p> },
        {
          id: 'actions',
          header: '',
          align: 'right',
          cell: (d) => (can('webhook.manage') && d.event_type ? <Button size="sm" variant="outline" disabled={busy === d.id} onClick={() => void requeue(d.id)}><RotateCcw /> Requeue</Button> : null),
        },
      ]}
    />
  );
}
