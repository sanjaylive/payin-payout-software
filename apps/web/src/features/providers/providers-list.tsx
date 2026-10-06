'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { formatRelative } from '@pay2all/ui/lib/format';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api/client';
import { toTableError } from '@/lib/api/errors';
import type { ProviderHealth, ProviderRow } from '@/lib/api/types';

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
export const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toLocaleString('en-IN')} ms`);

export function healthFor(p: ProviderRow, kind: 'PAYIN' | 'PAYOUT'): ProviderHealth | null {
  return (kind === 'PAYIN' ? p.health?.payin : p.health?.payout) ?? null;
}

export function ProviderStatus({ p }: { p: ProviderRow }) {
  return (
    <div className="space-y-0.5">
      <StatusBadge status={p.status} />
      <p className="text-muted-foreground text-[11px]">{p.status_source === 'AUTO' ? 'Auto (health)' : 'Manual'} · {formatRelative(p.status_changed_at)}</p>
    </div>
  );
}

export function ProvidersList({ kind }: { kind: 'PAYIN' | 'PAYOUT' }) {
  const router = useRouter();
  const providers = useQuery({ queryKey: ['providers', kind], queryFn: () => api.get<ProviderRow[]>('/v1/providers', { kind }), refetchInterval: 15_000 });
  return (
    <DataTable
      rows={providers.data}
      loading={providers.isFetching}
      error={toTableError(providers.error)}
      rowKey={(p) => p.id}
      onRowClick={(p) => router.push(`/admin/providers/${p.id}`)}
      empty={{ title: 'No providers configured' }}
      columns={[
        { id: 'name', header: 'Provider', cell: (p) => <div><p className="font-medium">{p.name}</p><p className="text-muted-foreground font-mono text-xs">{p.code} · {p.adapter_label}</p></div> },
        { id: 'status', header: 'Status', cell: (p) => <ProviderStatus p={p} /> },
        { id: 'env', header: 'Env', cell: (p) => <StatusBadge status={p.environment} tone={p.environment === 'LIVE' ? 'primary' : 'neutral'} /> },
        { id: 'success', header: 'Success (15m)', align: 'right', cell: (p) => <span className="tabular">{pct(healthFor(p, kind)?.success_rate)}</span> },
        { id: 'p95', header: 'p95', align: 'right', cell: (p) => <span className="tabular">{ms(healthFor(p, kind)?.p95_latency_ms)}</span> },
        { id: 'req', header: 'Requests', align: 'right', cell: (p) => <span className="tabular">{healthFor(p, kind)?.requests ?? 0}</span> },
        { id: 'creds', header: 'Credentials', cell: (p) => (p.credentials.some((c) => c.environment === p.environment) ? <StatusBadge status="CONFIGURED" tone="success" /> : <StatusBadge status="MISSING" tone="warning" />) },
      ]}
    />
  );
}
