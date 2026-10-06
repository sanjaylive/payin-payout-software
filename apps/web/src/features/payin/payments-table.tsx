'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { DateRangeFilter, type DateRangeValue, presetRange } from '@pay2all/ui/components/date-range-filter';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Input } from '@pay2all/ui/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { fmt } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { toTableError } from '@/lib/api/errors';
import type { PayinMethod, Payment } from '@/lib/api/types';
import { useCursorPagination } from '@/lib/hooks/use-cursor-pagination';
import { METHOD_LABELS, PAYMENT_STATUSES } from './labels';
import { PaymentDrawer } from './payment-drawer';

/** One search box: payment id, UTR/RRN (digits) or the merchant's order id. */
function searchParams(q: string): Record<string, string> {
  const v = q.trim();
  if (!v) return {};
  if (/^pay_[0-9A-Z]{26}$/i.test(v)) return { payment_id: `pay_${v.slice(4).toUpperCase()}` };
  if (/^\d{12}$/.test(v)) return { utr: v };
  return { merchant_order_id: v };
}

export function PaymentsTable({ method, internal = false }: { method?: PayinMethod; internal?: boolean }) {
  const pager = useCursorPagination();
  const [range, setRange] = useState<DateRangeValue>(() => presetRange('30d'));
  const [status, setStatus] = useState('ALL');
  const [methodFilter, setMethodFilter] = useState<string>(method ?? 'ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const query = {
    limit: 25,
    cursor: pager.cursor,
    created_from: range.from.toISOString(),
    created_to: range.to.toISOString(),
    status: status === 'ALL' ? undefined : status,
    method: methodFilter === 'ALL' ? undefined : methodFilter,
    ...searchParams(search),
  };
  const payments = useQuery({
    queryKey: ['payments', query],
    queryFn: () => api.list<Payment>('/v1/payments', query),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    pager.reset();
  };

  return (
    <>
      <DataTable
        rows={payments.data?.data}
        loading={payments.isFetching}
        error={toTableError(payments.error)}
        onRetry={() => void payments.refetch()}
        rowKey={(p) => p.payment_id}
        onRowClick={(p) => setSelected(p.payment_id)}
        empty={{ title: 'No payments match these filters', description: 'Try a wider date range or clear the filters.' }}
        pagination={{ hasPrevious: pager.hasPrevious, hasNext: Boolean(payments.data?.meta?.has_more), onPrevious: pager.previous, onNext: () => pager.next(payments.data?.meta?.next_cursor), pageLabel: `Page ${pager.page}` }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-72">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input className="pl-8" placeholder="Payment ID, order ID or UTR" value={search} onChange={(e) => reset(setSearch)(e.target.value)} aria-label="Search payments" />
            </div>
            <Select value={status} onValueChange={reset(setStatus)}>
              <SelectTrigger className="w-44" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {PAYMENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</SelectItem>)}
              </SelectContent>
            </Select>
            {!method && (
              <Select value={methodFilter} onValueChange={reset(setMethodFilter)}>
                <SelectTrigger className="w-40" aria-label="Method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All methods</SelectItem>
                  {Object.entries(METHOD_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <DateRangeFilter value={range} onChange={reset(setRange)} />
          </div>
        }
        columns={[
          { id: 'time', header: 'Created', cell: (p) => <span className="text-sm whitespace-nowrap">{formatDateTime(p.created_at)}</span> },
          {
            id: 'order',
            header: 'Order',
            cell: (p) => (
              <div>
                <p className="font-mono text-xs">{p.merchant_order_id}</p>
                <p className="text-muted-foreground font-mono text-[11px]">{p.payment_id}</p>
              </div>
            ),
          },
          ...(internal ? [{ id: 'merchant', header: 'Merchant', cell: (p: Payment) => <span className="font-mono text-xs">{p.merchant_id}</span> }, { id: 'provider', header: 'Provider', cell: (p: Payment) => <span className="text-xs">{p.provider ?? '—'}</span> }] : []),
          { id: 'method', header: 'Method', cell: (p) => <span className="text-sm">{METHOD_LABELS[p.method]}</span> },
          { id: 'utr', header: 'UTR', cell: (p) => <span className="font-mono text-xs">{p.utr ?? '—'}</span> },
          {
            id: 'status',
            header: 'Status',
            cell: (p) => (
              <span className="flex items-center gap-1.5">
                <StatusBadge status={p.status} />
                {p.requires_review && <TriangleAlert className="text-warning size-4" aria-label="Held for review" />}
              </span>
            ),
          },
          { id: 'amount', header: 'Amount', align: 'right', cell: (p) => <span className="tabular font-medium">{fmt(p.amount)}</span> },
          { id: 'net', header: 'Net', align: 'right', cell: (p) => <span className="tabular text-muted-foreground text-sm">{fmt(p.net_amount)}</span> },
        ]}
      />
      <PaymentDrawer paymentId={selected} onClose={() => setSelected(null)} />
    </>
  );
}
