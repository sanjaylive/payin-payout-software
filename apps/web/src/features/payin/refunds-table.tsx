'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fmt } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { toTableError } from '@/lib/api/errors';
import type { Refund } from '@/lib/api/types';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { PaymentDrawer } from './payment-drawer';

const STATUSES = ['CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW'] as const;

export function RefundsTable() {
  const pager = useCursorPagination();
  const [status, setStatus] = useState('ALL');
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const query = { limit: 25, cursor: pager.cursor, status: status === 'ALL' ? undefined : status };
  const refunds = useQuery({ queryKey: ['refunds', query], queryFn: () => api.list<Refund>('/v1/refunds', query), placeholderData: keepPreviousData, refetchInterval: 15_000 });
  return (
    <>
      <DataTable
        rows={refunds.data?.data}
        loading={refunds.isFetching}
        error={toTableError(refunds.error)}
        onRetry={() => void refunds.refetch()}
        rowKey={(r) => r.refund_id}
        onRowClick={(r) => setPaymentId(r.payment_id)}
        empty={{ title: 'No refunds yet', description: 'Refunds are initiated from a successful payment.' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(refunds.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(refunds.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        toolbar={
          <Select value={status} onValueChange={(v) => { setStatus(v); pager.reset(); }}>
            <SelectTrigger className="w-44" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</SelectItem>)}
            </SelectContent>
          </Select>
        }
        columns={[
          { id: 'time', header: 'Initiated', cell: (r) => <span className="text-sm whitespace-nowrap">{formatDateTime(r.created_at)}</span> },
          { id: 'refund', header: 'Refund', cell: (r) => <div><p className="font-mono text-xs">{r.merchant_refund_id ?? r.refund_id}</p><p className="text-muted-foreground font-mono text-[11px]">for {r.payment_id}</p></div> },
          { id: 'reason', header: 'Reason', cell: (r) => <span className="text-muted-foreground text-sm">{r.failure_reason ?? r.reason ?? '—'}</span> },
          { id: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { id: 'amount', header: 'Amount', align: 'right', cell: (r) => <span className="tabular font-medium">{fmt(r.amount)}</span> },
        ]}
      />
      <PaymentDrawer paymentId={paymentId} onClose={() => setPaymentId(null)} />
    </>
  );
}
