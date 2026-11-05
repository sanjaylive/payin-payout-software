'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@pay2all/ui/components/ui/table';
import { cn } from '@pay2all/ui/lib/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CircleDollarSign, Download, Loader2, Wallet } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { api, apiDownload } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { type AgentSummary, dayLabel, inr, MODE_LABEL, presetDates, RANGE_PRESETS, type RangePreset, rupeesToMinor, STATUS_LABEL } from './api';
import { statusTone, TxnStatus } from './bits';
import { AGENT_KEY } from './hooks';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-card overflow-hidden rounded-xl border">
      <h2 className="border-b px-4 py-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const num = (v: string) => Number(rupeesToMinor(v)) / 100;

/** /agent/reports: totals and breakdowns for a date range (IST days), and the CSV export. */
export function AgentReports() {
  const [preset, setPreset] = useState<RangePreset | 'custom'>('month');
  const [range, setRange] = useState(() => presetDates('month'));
  const [downloading, setDownloading] = useState(false);
  const valid = Boolean(range.from && range.to && range.from <= range.to);
  const q = useQuery({
    queryKey: [...AGENT_KEY, 'reports', range],
    queryFn: () => api.get<AgentSummary>('/v1/agent/reports/summary', range),
    enabled: valid,
    placeholderData: keepPreviousData,
  });

  async function download() {
    setDownloading(true);
    try {
      await apiDownload(`/v1/agent/reports/export?from=${range.from}&to=${range.to}`, `transactions-${range.from}-to-${range.to}.csv`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  }

  const s = q.data;
  const maxDay = Math.max(1, ...(s?.by_day ?? []).map((d) => Math.max(num(d.money_in), num(d.money_out))));

  return (
    <>
      <PageHeader
        title="Reports"
        description="Money in, money out and fees for any period. Failed and refunded entries are left out of totals."
        actions={
          <Button variant="outline" disabled={!valid || downloading} onClick={() => void download()}>
            {downloading ? <Loader2 className="animate-spin" /> : <Download />} Download CSV
          </Button>
        }
      />
      <div className="space-y-5">
        <div className="space-y-3">
          <div className="-mx-4 overflow-x-auto px-4">
            <div className="flex min-w-max gap-2" role="group" aria-label="Period">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={preset === p.id}
                  onClick={() => {
                    setPreset(p.id);
                    setRange(presetDates(p.id));
                  }}
                  className={cn('min-h-9 rounded-full border px-3.5 text-sm font-medium', preset === p.id ? 'bg-primary text-primary-foreground border-primary' : 'bg-card hover:border-primary/50')}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="r-from">From</Label>
              <Input id="r-from" type="date" value={range.from} max={range.to} onChange={(e) => {
                  setPreset('custom');
                  setRange((r) => ({ ...r, from: e.target.value }));
                }} className="w-44" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-to">To</Label>
              <Input id="r-to" type="date" value={range.to} min={range.from} onChange={(e) => {
                  setPreset('custom');
                  setRange((r) => ({ ...r, to: e.target.value }));
                }} className="w-44" />
            </div>
            {!valid && <p className="text-destructive pb-2 text-xs">Choose a start date on or before the end date.</p>}
          </div>
        </div>

        {q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Money in" value={s && inr(s.totals.money_in)} icon={ArrowDownLeft} loading={!s} />
              <StatCard label="Money out" value={s && inr(s.totals.money_out)} icon={ArrowUpRight} loading={!s} />
              <StatCard label="Fees earned" value={s && inr(s.totals.fees)} icon={CircleDollarSign} loading={!s} />
              <StatCard label="Net" value={s && inr(s.totals.net)} icon={Wallet} hint={s ? `${s.totals.count} entries` : undefined} loading={!s} />
            </div>

            {!s ? (
              <Skeleton className="h-64 rounded-xl" />
            ) : s.totals.count === 0 && s.by_status.length === 0 ? (
              <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">No entries in this period.</p>
            ) : (
              <div className={cn('space-y-5', q.isFetching && 'opacity-70')}>
                <Section title="By day">
                  <div className="flex items-center gap-4 px-4 pt-3 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="bg-success size-2.5 rounded-sm" aria-hidden /> In
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="bg-warning size-2.5 rounded-sm" aria-hidden /> Out
                    </span>
                  </div>
                  <ul className="divide-y">
                    {s.by_day.map((d) => (
                      <li key={d.date} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3 px-4 py-2.5 text-sm">
                        <span className="text-muted-foreground text-xs">{dayLabel(d.date)}</span>
                        <span className="space-y-1" aria-hidden>
                          <span className="bg-success block h-1.5 rounded-full" style={{ width: `${(num(d.money_in) / maxDay) * 100}%` }} />
                          <span className="bg-warning block h-1.5 rounded-full" style={{ width: `${(num(d.money_out) / maxDay) * 100}%` }} />
                        </span>
                        <span className="text-right text-xs tabular-nums">
                          <span className="block">
                            In {inr(d.money_in)} · Out {inr(d.money_out)}
                          </span>
                          <span className="text-muted-foreground block">
                            Fees {inr(d.fees)} · Net <span className="text-foreground font-medium">{inr(d.net)}</span> · {d.count}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>

                <div className="grid gap-5 lg:grid-cols-2">
                  <Section title="By type">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Type</TableHead>
                          <TableHead className="text-right">Entries</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead className="text-right">Fees</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {s.by_type.map((r) => (
                          <TableRow key={`${r.type}-${r.direction}`}>
                            <TableCell>
                              {r.label}
                              <span className="text-muted-foreground text-xs"> · {r.direction === 'IN' ? 'in' : 'out'}</span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                            <TableCell className="text-right tabular-nums">{inr(r.amount)}</TableCell>
                            <TableCell className="text-right tabular-nums">{inr(r.fees)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Section>
                  <Section title="By mode">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Mode</TableHead>
                          <TableHead className="text-right">Entries</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {s.by_mode.map((r) => (
                          <TableRow key={`${r.mode}-${r.direction}`}>
                            <TableCell>
                              {MODE_LABEL[r.mode]}
                              <span className="text-muted-foreground text-xs"> · {r.direction === 'IN' ? 'in' : 'out'}</span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                            <TableCell className="text-right tabular-nums">{inr(r.amount)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Section>
                </div>
                <Section title="By status (all entries)">
                  <ul className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
                    {s.by_status.map((r) => (
                      <li key={r.status} className={cn('rounded-lg border p-3', statusTone(r.status) === 'danger' && 'border-destructive/30')}>
                        <TxnStatus status={r.status} />
                        <p className="mt-2 font-semibold tabular-nums">{inr(r.amount)}</p>
                        <p className="text-muted-foreground text-xs">
                          {r.count} {STATUS_LABEL[r.status].toLowerCase()} {r.count === 1 ? 'entry' : 'entries'}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
