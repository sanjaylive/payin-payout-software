'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Button } from '@pay2all/ui/components/ui/button';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Banknote, CircleDollarSign, Landmark, Receipt, Smartphone, Wallet } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import { type AgentDashboard, type AgentTxnType, inr } from './api';
import { TxnRow, UsageBar } from './bits';
import { DASHBOARD_KEY } from './hooks';

const ACTIONS: { type: AgentTxnType; label: string; icon: typeof Wallet; tone: string }[] = [
  { type: 'MONEY_TRANSFER', label: 'Money transfer', icon: ArrowLeftRight, tone: 'bg-primary/10 text-primary' },
  { type: 'CASH_WITHDRAWAL', label: 'Cash withdrawal', icon: Banknote, tone: 'bg-warning-muted text-warning-foreground dark:text-warning' },
  { type: 'CASH_DEPOSIT', label: 'Cash deposit', icon: Landmark, tone: 'bg-success-muted text-success' },
  { type: 'BILL_PAYMENT', label: 'Bill / recharge', icon: Smartphone, tone: 'bg-info-muted text-info' },
  { type: 'OTHER', label: 'Other', icon: CircleDollarSign, tone: 'bg-muted text-foreground' },
];

/** /agent: today's counter at a glance, quick entry buttons and the latest entries. */
export function AgentHome() {
  const can = useCan();
  const q = useQuery({ queryKey: DASHBOARD_KEY, queryFn: () => api.get<AgentDashboard>('/v1/agent/dashboard'), refetchInterval: 60_000 });
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const loading = !d;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="text-muted-foreground text-sm">
          {new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }).format(new Date())}
          {d ? ` · ${d.today.count} ${d.today.count === 1 ? 'entry' : 'entries'}` : ''}
        </p>
      </div>

      {can('agent.desk.write') && (
        <section aria-label="Quick actions" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {ACTIONS.map((a) => (
            <Link
              key={a.type}
              href={`/agent/new?type=${a.type}`}
              className="bg-card hover:border-primary/50 focus-visible:ring-ring/50 flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border p-3 text-center text-xs font-medium outline-none focus-visible:ring-[3px] sm:text-sm"
            >
              <span className={`grid size-10 place-items-center rounded-full ${a.tone}`}>
                <a.icon className="size-5" aria-hidden />
              </span>
              {a.label}
            </Link>
          ))}
        </section>
      )}

      <section aria-label="Today’s totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Money in" value={d && inr(d.today.money_in)} icon={ArrowDownLeft} loading={loading} className="py-4" />
        <StatCard label="Money out" value={d && inr(d.today.money_out)} icon={ArrowUpRight} loading={loading} className="py-4" />
        <StatCard label="Fees earned" value={d && inr(d.today.fees)} icon={CircleDollarSign} loading={loading} className="py-4" />
        <StatCard label="Net at counter" value={d && inr(d.today.net)} icon={Wallet} hint="In − out + fees" loading={loading} className="py-4" />
      </section>

      <section aria-label="This month" className="grid gap-3 lg:grid-cols-[1fr_1.2fr]">
        <div className="bg-card grid grid-cols-3 divide-x rounded-xl border p-4">
          <div className="pr-3">
            <p className="text-muted-foreground text-xs">This month</p>
            <div className="mt-1 font-semibold tabular-nums">{d ? inr(d.month.volume) : <Skeleton className="h-5 w-20" />}</div>
          </div>
          <div className="px-3">
            <p className="text-muted-foreground text-xs">Fees</p>
            <div className="mt-1 font-semibold tabular-nums">{d ? inr(d.month.fees) : <Skeleton className="h-5 w-16" />}</div>
          </div>
          <div className="pl-3">
            <p className="text-muted-foreground text-xs">Customers</p>
            <div className="mt-1 font-semibold tabular-nums">{d ? d.customers.toLocaleString('en-IN') : <Skeleton className="h-5 w-10" />}</div>
          </div>
        </div>
        {d ? <UsageBar plan={d.profile.plan} usage={d.profile.usage} canUpgrade={can('agent.billing.manage')} /> : <Skeleton className="h-20 rounded-xl" />}
      </section>

      <section aria-labelledby="recent-h" className="bg-card overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 id="recent-h" className="text-sm font-semibold">
            Recent entries
          </h2>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/agent/transactions">See all</Link>
          </Button>
        </div>
        {!d ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : d.recent.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-6 py-10 text-center text-sm">
            <Receipt className="size-6" aria-hidden />
            No entries yet. Record your first transaction with the buttons above.
          </div>
        ) : (
          <ul className="divide-y">
            {d.recent.map((t) => (
              <li key={t.id}>
                <TxnRow t={t} href={`/agent/receipts/${t.id}`} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
