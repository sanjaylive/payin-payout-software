'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Input } from '@pay2all/ui/components/ui/input';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery } from '@tanstack/react-query';
import { Coins, Landmark, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { fmt } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { toTableError } from '@/lib/api/errors';
import type { ResellerEarnings } from '@/lib/api/types';

const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);

export function useEarnings(resellerId: string | undefined, month: string) {
  return useQuery({ queryKey: ['earnings', resellerId, month], queryFn: () => api.get<ResellerEarnings>(`/v1/resellers/${resellerId}/earnings`, { month }), enabled: Boolean(resellerId) });
}

export function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return <Input type="month" value={month} onChange={(e) => e.target.value && onChange(e.target.value)} className="w-44" aria-label="Month" />;
}

export function CommissionsByMerchant({ resellerId }: { resellerId: string }) {
  const [month, setMonth] = useState(thisMonth);
  const q = useEarnings(resellerId, month);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2"><p className="text-muted-foreground text-sm">Your margin per merchant: their fee minus your wholesale price, on transactions that moved money.</p><MonthPicker month={month} onChange={setMonth} /></div>
      <DataTable
        rows={q.data?.by_merchant}
        loading={q.isFetching}
        error={toTableError(q.error)}
        rowKey={(r) => r.merchant_id}
        empty={{ title: 'No merchants yet' }}
        columns={[
          { id: 'name', header: 'Merchant', cell: (r) => <Link className="font-medium hover:underline" href={`/reseller/merchants/${r.merchant_id}`}>{r.name}</Link> },
          { id: 'payins', header: 'Payins', align: 'right', cell: (r) => <span className="tabular text-sm">{r.payin_count} · {fmt(r.payin_margin)}</span> },
          { id: 'payouts', header: 'Payouts', align: 'right', cell: (r) => <span className="tabular text-sm">{r.payout_count} · {fmt(r.payout_margin)}</span> },
          { id: 'total', header: 'Commission', align: 'right', cell: (r) => <span className="tabular font-medium">{fmt(r.total)}</span> },
        ]}
      />
    </div>
  );
}

export function EarningsOverview({ resellerId }: { resellerId: string }) {
  const [month, setMonth] = useState(thisMonth);
  const q = useEarnings(resellerId, month);
  const e = q.data;
  return (
    <div className="space-y-6">
      <div className="flex justify-end"><MonthPicker month={month} onChange={setMonth} /></div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Payable to you" value={e ? fmt(e.payable_balance) : '—'} loading={q.isPending} icon={Wallet} hint="Accrued, not yet paid out" />
        <StatCard label={`Earned in ${month}`} value={e ? fmt(e.accrued_this_month) : '—'} loading={q.isPending} icon={Coins} hint={e ? `${fmt(e.accrued_lifetime)} lifetime` : undefined} />
        <StatCard label="Paid out (lifetime)" value={e ? fmt(e.paid_lifetime) : '—'} loading={q.isPending} icon={Landmark} />
      </div>
      <DataTable
        rows={e?.payouts}
        loading={q.isFetching}
        rowKey={(p) => p.payout_id}
        empty={{ title: 'No commission payouts yet', description: 'Pay2All pays accrued commission to your registered bank account.' }}
        columns={[
          { id: 'date', header: 'Paid', cell: (p) => <span className="text-sm">{formatDateTime(p.created_at)}</span> },
          { id: 'note', header: 'Period', cell: (p) => <span className="text-sm">{p.period_note ?? '—'}</span> },
          { id: 'utr', header: 'UTR', cell: (p) => <span className="font-mono text-xs">{p.utr}</span> },
          { id: 'amount', header: 'Amount', align: 'right', cell: (p) => <span className="tabular font-medium">{fmt(p.amount)}</span> },
        ]}
      />
    </div>
  );
}
