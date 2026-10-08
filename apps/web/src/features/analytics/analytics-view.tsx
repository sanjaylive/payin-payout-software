'use client';

import { DateRangeFilter, type DateRangeValue, presetRange } from '@pay2all/ui/components/date-range-filter';
import { EmptyState, ErrorState } from '@pay2all/ui/components/states';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { useQuery } from '@tanstack/react-query';
import { Activity, ChartColumn, Gauge, IndianRupee, Receipt } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { fmt } from '@/features/ledger/format';
import { ColumnChart } from '@/features/payin/column-chart';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';

interface Outcome {
  count: number;
  success_count: number;
  failed_count: number;
  success_rate: number | null;
  success_amount: string;
}
interface Analytics {
  kind: 'payin' | 'payout';
  totals: Outcome & { avg_ticket: string | null };
  live: Outcome & { window_minutes: number };
  by_method: (Outcome & { method: string })[];
  by_gateway: (Outcome & { provider_id: string; code: string; name: string })[] | null;
  failure_reasons: { code: string; reason: string | null; count: number; share: number }[];
  hours: (Outcome & { hour: number })[];
  peak_hour: number | null;
}

const LIVE_REFRESH_MS = 30_000;
const METHOD_LABELS: Record<string, string> = { UPI_QR: 'UPI QR', UPI_INTENT: 'UPI intent', UPI_STATIC_QR: 'Static QR', PAYMENT_LINK: 'Payment link', VIRTUAL_ACCOUNT: 'Virtual account', CARD: 'Card', NETBANKING: 'Netbanking' };
const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** Analytics (docs/ANALYTICS.md): success rate by method and gateway, failure reasons, peak hours. */
export function AnalyticsView({ title = 'Analytics', level }: { title?: string; level?: 1 | 2 }) {
  const can = useCan();
  const [kind, setKind] = useState<'payin' | 'payout'>(can('payin.read') ? 'payin' : 'payout');
  const [range, setRange] = useState<DateRangeValue>(() => presetRange('7d'));
  const q = useQuery({
    queryKey: ['analytics', kind, range.from.toISOString(), range.to.toISOString()],
    queryFn: () => api.get<Analytics>('/v1/analytics', { kind, from: range.from.toISOString(), to: range.to.toISOString() }),
    refetchInterval: LIVE_REFRESH_MS,
  });
  const d = q.data;
  const noun = kind === 'payin' ? 'payments' : 'payouts';

  return (
    <>
      <PageHeader level={level} title={title} description="Success rates, failure reasons and busiest hours. Refreshes every 30 seconds." actions={<DateRangeFilter value={range} onChange={setRange} />} />
      <Tabs value={kind} onValueChange={(v) => setKind(v as 'payin' | 'payout')} className="mb-4">
        <TabsList>
          {can('payin.read') && <TabsTrigger value="payin">Payin</TabsTrigger>}
          {can('payout.read') && <TabsTrigger value="payout">Payout</TabsTrigger>}
        </TabsList>
      </Tabs>
      {q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Success rate" value={d ? pct(d.totals.success_rate) : '—'} loading={!d} icon={Gauge} hint={d ? `${d.totals.success_count.toLocaleString('en-IN')} of ${(d.totals.success_count + d.totals.failed_count).toLocaleString('en-IN')} completed ${noun}` : undefined} />
            <StatCard label="Successful volume" value={d ? fmt(d.totals.success_amount) : '—'} loading={!d} icon={IndianRupee} hint={d?.totals.avg_ticket ? `Average ${fmt(d.totals.avg_ticket)}` : undefined} />
            <StatCard label={kind === 'payin' ? 'Payments' : 'Payouts'} value={d ? d.totals.count.toLocaleString('en-IN') : '—'} loading={!d} icon={Receipt} hint={d ? `${d.totals.failed_count.toLocaleString('en-IN')} failed${kind === 'payin' ? ' or expired' : ''}` : undefined} />
            <StatCard
              label={`Last ${d?.live.window_minutes ?? 15} minutes`}
              value={d ? `${d.live.count.toLocaleString('en-IN')} · ${pct(d.live.success_rate)}` : '—'}
              loading={!d}
              icon={Activity}
              hint={
                <span className="flex items-center gap-1.5">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:hidden" />
                    <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                  </span>
                  Live: count · success rate
                </span>
              }
            />
          </div>

          {d && d.totals.count === 0 ? (
            <EmptyState icon={ChartColumn} title={`No ${noun} in this period`} description="Widen the date range." className="py-10" />
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <RateCard title={kind === 'payin' ? 'By payment method' : 'By transfer mode'} rows={d?.by_method.map((r) => ({ key: r.method, label: METHOD_LABELS[r.method] ?? r.method, ...r }))} />
                {d?.by_gateway ? (
                  <RateCard title="By gateway" description="Platform view: the gateway that handled the transaction." rows={d.by_gateway.map((r) => ({ key: r.provider_id, label: r.name, sub: r.code, ...r }))} />
                ) : (
                  <FailureCard reasons={d?.failure_reasons} />
                )}
              </div>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Card className="shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Busiest hours</CardTitle>
                    <CardDescription>
                      {noun[0]!.toUpperCase() + noun.slice(1)} by hour of day (IST), all days in the range{d?.peak_hour != null ? ` · peak ${hourLabel(d.peak_hour)}–${hourLabel((d.peak_hour + 1) % 24)}` : ''}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {!d ? (
                      <Skeleton className="h-52" />
                    ) : (
                      <ColumnChart
                        data={d.hours.map((h) => ({ label: String(h.hour).padStart(2, '0'), title: `${hourLabel(h.hour)}–${hourLabel((h.hour + 1) % 24)} IST`, values: { success: h.success_count, failed: h.failed_count, other: h.count - h.success_count - h.failed_count } }))}
                        series={[
                          { key: 'success', label: 'Successful', color: 'var(--primary)' },
                          { key: 'failed', label: 'Failed', color: 'var(--destructive)' },
                          { key: 'other', label: 'In progress', color: 'var(--muted-foreground)' },
                        ]}
                        formatValue={(v) => Math.round(v).toLocaleString('en-IN')}
                        integer
                        ariaLabel="Transactions by hour of day"
                      />
                    )}
                  </CardContent>
                </Card>
                {d?.by_gateway ? <FailureCard reasons={d.failure_reasons} /> : <div className="hidden lg:block" />}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

interface RateRow extends Outcome {
  key: string;
  label: string;
  sub?: string;
}

/** Success rate per row as a 0–100% bar; counts and volume beside it so the bar is never the only cue. */
function RateCard({ title, description, rows }: { title: string; description?: string; rows?: RateRow[] }) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description ?? 'Success rate of completed transactions'}</CardDescription>
      </CardHeader>
      <CardContent>
        {!rows ? (
          <Skeleton className="h-40" />
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate font-medium">
                    {r.label} {r.sub && <span className="text-muted-foreground font-mono text-xs">{r.sub}</span>}
                  </span>
                  <span className="tabular font-semibold">{pct(r.success_rate)}</span>
                </div>
                <div className="bg-muted h-2 overflow-hidden rounded-full" role="presentation">
                  <div className="bg-primary h-full rounded-full" style={{ width: `${(r.success_rate ?? 0) * 100}%` }} />
                </div>
                <p className="text-muted-foreground tabular text-xs">
                  {r.count.toLocaleString('en-IN')} total · {r.success_count.toLocaleString('en-IN')} ok · {r.failed_count.toLocaleString('en-IN')} failed · {fmt(r.success_amount)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FailureCard({ reasons }: { reasons?: Analytics['failure_reasons'] }) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Top failure reasons</CardTitle>
        <CardDescription>Share of failed transactions</CardDescription>
      </CardHeader>
      <CardContent>
        {!reasons ? (
          <Skeleton className="h-40" />
        ) : reasons.length === 0 ? (
          <p className="text-muted-foreground text-sm">No failures in this period.</p>
        ) : (
          <ul className="space-y-3">
            {reasons.map((r) => (
              <li key={r.code} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate" title={r.reason ?? undefined}>
                    {r.reason ?? r.code} <span className="text-muted-foreground font-mono text-xs">{r.code}</span>
                  </span>
                  <span className="tabular shrink-0 font-medium">
                    {r.count.toLocaleString('en-IN')} · {pct(r.share)}
                  </span>
                </div>
                <div className="bg-muted h-1.5 overflow-hidden rounded-full" role="presentation">
                  <div className="bg-destructive/80 h-full rounded-full" style={{ width: `${r.share * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
