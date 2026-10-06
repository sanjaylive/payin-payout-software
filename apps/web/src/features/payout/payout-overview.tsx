'use client';

import type { DateRangeValue } from '@pay2all/ui/components/date-range-filter';
import { EmptyState } from '@pay2all/ui/components/states';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { ArrowUpFromLine, ChartColumn, CircleCheck, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { fmt } from '@/features/ledger/format';
import { ColumnChart } from '@/features/payin/column-chart';
import { buckets, compactInr, useTxnStats } from '@/features/payin/payin-overview';

export function usePayoutStats(range: DateRangeValue, merchantId?: string, enabled = true) {
  return useTxnStats('/v1/payouts/stats', range, merchantId, enabled);
}

export function PayoutStatCards({ range, merchantId, approvalsHref }: { range: DateRangeValue; merchantId?: string; approvalsHref?: string }) {
  const stats = usePayoutStats(range, merchantId);
  const t = stats.data?.totals;
  return (
    <>
      <StatCard label="Payouts sent" value={t ? fmt(t.success_amount) : '—'} loading={stats.isPending} icon={ArrowUpFromLine} hint={t ? `${t.success_count.toLocaleString('en-IN')} successful` : undefined} />
      <StatCard label="Payout success rate" value={t?.success_rate == null ? '—' : `${(t.success_rate * 100).toFixed(1)}%`} loading={stats.isPending} icon={CircleCheck} hint={t ? `${t.failed_count.toLocaleString('en-IN')} failed` : undefined} />
      {approvalsHref && <StatCard label="Awaiting approval" value={t ? (t.pending_approval_count ?? 0).toLocaleString('en-IN') : '—'} loading={stats.isPending} icon={ShieldCheck} hint={<Link href={approvalsHref} className="hover:underline">Review approvals</Link>} />}
    </>
  );
}

export function PayoutChart({ range, merchantId }: { range: DateRangeValue; merchantId?: string }) {
  const stats = usePayoutStats(range, merchantId);
  const data = stats.data ? buckets(range, stats.unit, stats.data) : [];
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Payout volume</CardTitle>
        <CardDescription>Successful payouts per {stats.unit}, IST</CardDescription>
      </CardHeader>
      <CardContent>
        {stats.isPending ? (
          <Skeleton className="h-52 w-full" />
        ) : stats.data?.totals.count === 0 ? (
          <EmptyState icon={ChartColumn} title="No payouts in this period" className="py-8" />
        ) : (
          <ColumnChart data={data} series={[{ key: 'amount', label: 'Paid out', color: 'var(--primary)' }]} formatValue={compactInr} ariaLabel="Successful payout amount per period" />
        )}
      </CardContent>
    </Card>
  );
}
