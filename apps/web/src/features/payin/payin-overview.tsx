'use client';

import type { DateRangeValue } from '@pay2all/ui/components/date-range-filter';
import { EmptyState } from '@pay2all/ui/components/states';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { formatMinor } from '@pay2all/ui/lib/money';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ChartColumn, CircleCheck, Receipt } from 'lucide-react';
import type { ReactNode } from 'react';
import { fmt, majorToMinor } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import type { PaymentStats } from '@/lib/api/types';
import { type ColumnDatum, ColumnChart } from './column-chart';

const IST_MS = 330 * 60_000;

/** Server buckets are IST wall-clock times serialised as UTC; build the same keys to fill gaps. */
function buckets(range: DateRangeValue, unit: 'hour' | 'day', stats: PaymentStats): (ColumnDatum & { key: string })[] {
  const byKey = new Map(stats.series.map((s) => [new Date(s.bucket_start).toISOString(), s]));
  const step = unit === 'hour' ? 3_600_000 : 86_400_000;
  const startIst = new Date(range.from.getTime() + IST_MS);
  if (unit === 'hour') startIst.setUTCMinutes(0, 0, 0);
  else startIst.setUTCHours(0, 0, 0, 0);
  const endIst = range.to.getTime() + IST_MS;
  const out: (ColumnDatum & { key: string })[] = [];
  for (let t = startIst.getTime(); t < endIst && out.length < 400; t += step) {
    const d = new Date(t);
    const key = d.toISOString();
    const s = byKey.get(key);
    const opts: Intl.DateTimeFormatOptions = { timeZone: 'UTC' };
    out.push({
      key,
      label: unit === 'hour' ? d.toLocaleTimeString('en-IN', { ...opts, hour: 'numeric' }) : d.toLocaleDateString('en-IN', { ...opts, day: 'numeric', month: 'short' }),
      title: unit === 'hour' ? `${d.toLocaleDateString('en-IN', { ...opts, day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-IN', { ...opts, hour: 'numeric', minute: '2-digit' })} IST` : d.toLocaleDateString('en-IN', { ...opts, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
      values: {
        // Chart geometry only — displayed values go through the exact formatter.
        amount: s ? Number(majorToMinor(s.success_amount)) : 0,
        success: s?.success_count ?? 0,
        failed: s?.failed_count ?? 0,
      },
    });
  }
  return out;
}

const compactInr = (minor: number) => (minor >= 1e9 ? `₹${(minor / 1e9).toFixed(1)}Cr` : minor >= 1e7 ? `₹${(minor / 1e7).toFixed(1)}L` : minor >= 1e5 ? `₹${(minor / 1e5).toFixed(1)}K` : formatMinor(BigInt(Math.round(minor))));

export function usePaymentStats(range: DateRangeValue, merchantId?: string, enabled = true) {
  const unit: 'hour' | 'day' = range.to.getTime() - range.from.getTime() <= 2 * 86_400_000 ? 'hour' : 'day';
  const query = useQuery({
    queryKey: ['payment-stats', range.from.toISOString(), range.to.toISOString(), unit, merchantId],
    queryFn: () => api.get<PaymentStats>('/v1/payments/stats', { from: range.from.toISOString(), to: range.to.toISOString(), bucket: unit, merchant_id: merchantId }),
    refetchInterval: 30_000,
    enabled,
  });
  return { ...query, unit };
}

export function PayinStatCards({ range, merchantId }: { range: DateRangeValue; merchantId?: string }) {
  const stats = usePaymentStats(range, merchantId);
  const t = stats.data?.totals;
  return (
    <>
      <StatCard label="Payins collected" value={t ? fmt(t.success_amount) : '—'} loading={stats.isPending} icon={ArrowDownToLine} hint={t ? `${t.success_count.toLocaleString('en-IN')} successful payments` : undefined} />
      <StatCard label="Payin success rate" value={t?.success_rate == null ? '—' : `${(t.success_rate * 100).toFixed(1)}%`} loading={stats.isPending} icon={CircleCheck} hint={t ? `${t.failed_count.toLocaleString('en-IN')} failed or expired` : undefined} />
      <StatCard label="Payments created" value={t ? t.count.toLocaleString('en-IN') : '—'} loading={stats.isPending} icon={Receipt} hint="Including open and failed" />
    </>
  );
}

export function PayinCharts({ range, merchantId }: { range: DateRangeValue; merchantId?: string }) {
  const stats = usePaymentStats(range, merchantId);
  const data = stats.data ? buckets(range, stats.unit, stats.data) : [];
  const empty = stats.data && stats.data.totals.count === 0;
  const body = (chart: ReactNode) =>
    stats.isPending ? <Skeleton className="h-52 w-full" /> : empty ? <EmptyState icon={ChartColumn} title="No payments in this period" description="Create a payment or widen the date range." className="py-8" /> : chart;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Payin volume</CardTitle>
          <CardDescription>Successful collections per {stats.unit}, IST</CardDescription>
        </CardHeader>
        <CardContent>
          {body(<ColumnChart data={data} series={[{ key: 'amount', label: 'Collected', color: 'var(--primary)' }]} formatValue={compactInr} ariaLabel="Successful payin amount per period" />)}
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Payments by outcome</CardTitle>
          <CardDescription>Successful vs failed or expired, per {stats.unit}</CardDescription>
        </CardHeader>
        <CardContent>
          {body(
            <ColumnChart
              data={data}
              series={[
                { key: 'success', label: 'Successful', color: 'var(--primary)' },
                { key: 'failed', label: 'Failed / expired', color: 'var(--destructive)' },
              ]}
              formatValue={(v) => Math.round(v).toLocaleString('en-IN')}
              integer
              ariaLabel="Successful and failed payment counts per period"
            />,
          )}
        </CardContent>
      </Card>
    </div>
  );
}
