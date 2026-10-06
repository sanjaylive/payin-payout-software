'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { TransactionDetailsDrawer } from '@pay2all/ui/components/details-drawer';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Filter } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api/client';
import { toTableError } from '@/lib/api/errors';
import type { AuditLogRow } from '@/lib/api/types';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <section>
      <h4 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">{title}</h4>
      <pre className="bg-muted overflow-x-auto rounded-lg p-3 font-mono text-xs leading-5">{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

const SEVERE = /failed|reuse|locked|suspended|disabled|revoked/;

/** Read-only view over the append-only audit trail, filtered server-side. */
export function AuditLogTable() {
  const pager = useCursorPagination();
  const [draft, setDraft] = useState({ action: '', resource_type: '', resource_id: '' });
  const [filters, setFilters] = useState(draft);
  const [selected, setSelected] = useState<AuditLogRow | null>(null);

  const logs = useQuery({
    queryKey: ['audit-logs', pager.cursor, filters],
    queryFn: () =>
      api.list<AuditLogRow>('/v1/audit-logs', {
        cursor: pager.cursor,
        limit: 50,
        action: filters.action || undefined,
        resource_type: filters.resource_type || undefined,
        resource_id: filters.resource_id || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <DataTable
        toolbar={
          <form
            className="flex w-full flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              pager.reset();
              setFilters(draft);
            }}
          >
            <Input className="w-56" placeholder="Action prefix (e.g. auth.login)" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} aria-label="Action" />
            <Input className="w-40" placeholder="Resource type" value={draft.resource_type} onChange={(e) => setDraft({ ...draft, resource_type: e.target.value })} aria-label="Resource type" />
            <Input className="w-64" placeholder="Resource ID" value={draft.resource_id} onChange={(e) => setDraft({ ...draft, resource_id: e.target.value })} aria-label="Resource ID" />
            <Button type="submit" variant="secondary"><Filter /> Apply</Button>
          </form>
        }
        rows={logs.data?.data}
        loading={logs.isFetching}
        error={toTableError(logs.error)}
        onRetry={() => void logs.refetch()}
        rowKey={(r) => r.id}
        onRowClick={setSelected}
        empty={{ title: 'No audit events match these filters' }}
        pagination={{
          hasPrevious: pager.hasPrevious,
          hasNext: Boolean(logs.data?.meta?.has_more),
          onPrevious: pager.previous,
          onNext: () => pager.next(logs.data?.meta?.next_cursor),
          pageLabel: `Page ${pager.page}`,
        }}
        columns={[
          { id: 'time', header: 'Time', cell: (r) => <span className="text-sm whitespace-nowrap">{formatDateTime(r.created_at)}</span> },
          {
            id: 'action',
            header: 'Action',
            cell: (r) => <span className={`font-mono text-xs ${SEVERE.test(r.action) ? 'text-destructive' : ''}`}>{r.action}</span>,
          },
          { id: 'resource', header: 'Resource', cell: (r) => <span className="font-mono text-xs">{r.resource_type}{r.resource_id ? ` · ${r.resource_id}` : ''}</span> },
          { id: 'actor', header: 'Actor', cell: (r) => <span className="font-mono text-xs">{r.actor_id ?? r.actor_type}</span> },
          { id: 'ip', header: 'IP', cell: (r) => <span className="text-muted-foreground font-mono text-xs">{r.ip_address ?? '—'}</span> },
        ]}
      />
      <TransactionDetailsDrawer
        open={Boolean(selected)}
        onOpenChange={(o) => !o && setSelected(null)}
        title={<span className="font-mono text-base">{selected?.action}</span>}
        subtitle={selected && <StatusBadge status="IMMUTABLE" tone="neutral" />}
        sections={
          selected
            ? [
                {
                  title: 'Event',
                  fields: [
                    { label: 'Audit ID', value: selected.id, mono: true },
                    { label: 'Time', value: formatDateTime(selected.created_at) },
                    { label: 'Resource', value: `${selected.resource_type} ${selected.resource_id ?? ''}`, mono: true },
                    { label: 'Organization', value: selected.organization_id ?? 'Platform', mono: true },
                  ],
                },
                {
                  title: 'Actor',
                  fields: [
                    { label: 'Type', value: selected.actor_type },
                    { label: 'Actor ID', value: selected.actor_id ?? '—', mono: true },
                    { label: 'Roles', value: selected.actor_role ?? '—' },
                    { label: 'IP address', value: selected.ip_address ?? '—', mono: true },
                    { label: 'User agent', value: selected.user_agent ?? '—' },
                    { label: 'Request ID', value: selected.request_id ?? '—', mono: true },
                  ],
                },
              ]
            : []
        }
      >
        {selected && (
          <>
            <JsonBlock title="Previous value" value={selected.old_value} />
            <JsonBlock title="New value" value={selected.new_value} />
            <JsonBlock title="Metadata" value={selected.metadata} />
          </>
        )}
      </TransactionDetailsDrawer>
    </>
  );
}
