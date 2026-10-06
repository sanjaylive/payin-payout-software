'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { DateRangeFilter, type DateRangeValue, presetRange } from '@pay2all/ui/components/date-range-filter';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Input } from '@pay2all/ui/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { fmt } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { toTableError } from '@/lib/api/errors';
import type { Payout } from '@/lib/api/types';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { MODE_LABELS, PAYOUT_STATUSES, statusLabel } from './labels';
import { PayoutDrawer } from './payout-drawer';

function searchParams(q: string): Record<string, string> {
  const v = q.trim();
  if (!v) return {};
  if (/^pout_[0-9A-Z]{26}$/i.test(v)) return { payout_id: `pout_${v.slice(5).toUpperCase()}` };
  if (/^\d{12}$/.test(v)) return { utr: v };
  return { merchant_order_id: v };
}

export function PayoutsTable({ internal = false, awaitingMyApproval = false, status, batchId }: { internal?: boolean; awaitingMyApproval?: boolean; status?: string; batchId?: string }) {
  const pager = useCursorPagination();
  const [range, setRange] = useState<DateRangeValue>(() => presetRange('30d'));
  const [statusFilter, setStatus] = useState(status ?? 'ALL');
  const [mode, setMode] = useState('ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const scoped = awaitingMyApproval || Boolean(batchId);
  const query = {
    limit: 25,
    cursor: pager.cursor,
    ...(scoped ? {} : { created_from: range.from.toISOString(), created_to: range.to.toISOString() }),
    status: statusFilter === 'ALL' ? undefined : statusFilter,
    mode: mode === 'ALL' ? undefined : mode,
    awaiting_my_approval: awaitingMyApproval ? 'true' : undefined,
    bulk_batch_id: batchId,
    ...searchParams(search),
  };
  const payouts = useQuery({ queryKey: ['payouts', query], queryFn: () => api.list<Payout>('/v1/payouts', query), placeholderData: keepPreviousData, refetchInterval: 10_000 });
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    pager.reset();
  };

  return (
    <>
      <DataTable
        rows={payouts.data?.data}
        loading={payouts.isFetching}
        error={toTableError(payouts.error)}
        onRetry={() => void payouts.refetch()}
        rowKey={(p) => p.payout_id}
        onRowClick={(p) => setSelected(p.payout_id)}
        empty={awaitingMyApproval ? { title: 'Nothing waiting for you', description: 'Payouts that need your approval appear here.' } : { title: 'No payouts match these filters' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(payouts.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(payouts.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        toolbar={
          scoped ? undefined : (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-72">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <Input className="pl-8" placeholder="Payout ID, order ID or UTR" value={search} onChange={(e) => reset(setSearch)(e.target.value)} aria-label="Search payouts" />
              </div>
              <Select value={statusFilter} onValueChange={reset(setStatus)}>
                <SelectTrigger className="w-44" aria-label="Status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  {PAYOUT_STATUSES.map((s) => <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={mode} onValueChange={reset(setMode)}>
                <SelectTrigger className="w-32" aria-label="Mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All modes</SelectItem>
                  {Object.keys(MODE_LABELS).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                </SelectContent>
              </Select>
              <DateRangeFilter value={range} onChange={reset(setRange)} />
            </div>
          )
        }
        columns={[
          { id: 'time', header: 'Created', cell: (p) => <span className="text-sm whitespace-nowrap">{formatDateTime(p.created_at)}</span> },
          { id: 'beneficiary', header: 'Beneficiary', cell: (p) => <div><p className="text-sm font-medium">{p.beneficiary.name}</p><p className="text-muted-foreground font-mono text-xs">{p.beneficiary.upi_id ?? `${p.beneficiary.account_number_masked} · ${p.beneficiary.ifsc}`}</p></div> },
          { id: 'order', header: 'Order', cell: (p) => <div><p className="font-mono text-xs">{p.merchant_order_id}</p><p className="text-muted-foreground font-mono text-[11px]">{p.payout_id}</p></div> },
          ...(internal ? [{ id: 'merchant', header: 'Merchant', cell: (p: Payout) => <span className="font-mono text-xs">{p.merchant_id}</span> }] : []),
          { id: 'mode', header: 'Mode', cell: (p) => <span className="text-sm">{p.mode}</span> },
          {
            id: 'status',
            header: 'Status',
            cell: (p) => (
              <span className="flex items-center gap-1.5">
                <StatusBadge status={p.status} />
                {p.status === 'APPROVAL_PENDING' && <span className="text-muted-foreground text-xs">{p.approvals_received}/{p.approvals_required}</span>}
              </span>
            ),
          },
          { id: 'amount', header: 'Amount', align: 'right', cell: (p) => <span className="tabular font-medium">{fmt(p.amount)}</span> },
        ]}
      />
      <PayoutDrawer payoutId={selected} onClose={() => setSelected(null)} />
    </>
  );
}
