'use client';

import { StatCard } from '@pay2all/ui/components/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { ArrowDownToLine, ArrowUpFromLine, Banknote, CircleAlert, Clock, FileWarning, Gauge, Hourglass, Landmark, Wallet } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { formatMinor } from '@pay2all/ui/lib/money';
import { fmt, majorToMinor } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { useCan } from '@/lib/auth/use-me';
import { PageHeader } from '@/components/common/page-header';
import { usePaymentStats } from '@/features/payin/payin-overview';
import { usePayoutStats } from '@/features/payout/payout-overview';
import { presetRange } from '@pay2all/ui/components/date-range-filter';

const todayRange = presetRange('today');

const CARDS = [
  { label: "Today's Payin", icon: ArrowDownToLine, phase: 5 },
  { label: "Today's Payout", icon: ArrowUpFromLine, phase: 6 },
  { label: 'Total Revenue', icon: Banknote, phase: 9 },
  { label: 'Total Merchant Balance', icon: Wallet, phase: 3 },
  { label: 'Unsettled Amount', icon: Hourglass, phase: 3 },
  { label: 'Settlements in Transit', icon: Landmark, phase: 8 },
  { label: 'Failed Payins Today', icon: CircleAlert, phase: 5 },
  { label: 'Pending Compliance', icon: FileWarning, phase: 2 },
  { label: 'Provider Health', icon: Gauge, phase: 4 },
  { label: 'Transactions / sec', icon: Clock, phase: 10 },
];

interface ProviderBrief {
  status: string;
}

interface Summary {
  total_merchant_balance: string;
  unsettled: string;
}

export default function AdminDashboard() {
  const can = useCan();
  const summary = useQuery({ queryKey: ['ledger-summary'], queryFn: () => api.get<Summary>('/v1/ledger/summary'), enabled: can('ledger.platform.read') });
  const providers = useQuery({ queryKey: ['providers', 'all'], queryFn: () => api.get<ProviderBrief[]>('/v1/providers'), enabled: can('provider.read') });
  const payin = usePaymentStats(todayRange, undefined, can('payin.read'));
  const payout = usePayoutStats(todayRange, undefined, can('payout.read'));
  const transit = useQuery({ queryKey: ['settlements', 'transit-summary'], queryFn: () => api.list<{ net: string }>('/v1/settlements', { status: 'PROCESSING', limit: 100 }), enabled: can('settlement.read') });
  const healthy = providers.data?.filter((p) => p.status === 'ACTIVE').length;
  const live: Record<string, string | undefined> = {
    'Provider Health': providers.data ? `${healthy}/${providers.data.filter((p) => p.status !== 'DISABLED').length} healthy` : undefined,
    'Total Merchant Balance': summary.data ? fmt(summary.data.total_merchant_balance) : undefined,
    'Unsettled Amount': summary.data ? fmt(summary.data.unsettled) : undefined,
    "Today's Payin": payin.data ? fmt(payin.data.totals.success_amount) : undefined,
    'Failed Payins Today': payin.data ? payin.data.totals.failed_count.toLocaleString('en-IN') : undefined,
    "Today's Payout": payout.data ? fmt(payout.data.totals.success_amount) : undefined,
    'Settlements in Transit': transit.data ? formatMinor(transit.data.data.reduce((s, r) => s + majorToMinor(r.net), 0n)) : undefined,
  };
  const PAYIN_CARDS = ["Today's Payin", 'Failed Payins Today'];
  return (
    <>
      <PageHeader title="Platform overview" description="Pay2All Payments operations console." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {CARDS.map((c) => (
          <StatCard
            key={c.label}
            label={c.label}
            value={live[c.label] ?? '—'}
            loading={c.label === 'Provider Health' ? providers.isPending && can('provider.read') : PAYIN_CARDS.includes(c.label) ? payin.isPending && can('payin.read') : c.label === "Today's Payout" ? payout.isPending && can('payout.read') : c.label === 'Settlements in Transit' ? transit.isPending && can('settlement.read') : c.label in live && summary.isPending && can('ledger.platform.read')}
            icon={c.icon}
            hint={c.label === 'Provider Health' && providers.data ? <Link href="/admin/settings/vendor-health" className="hover:underline">View health</Link> : PAYIN_CARDS.includes(c.label) && payin.data ? <Link href="/admin/transactions/payin" className="hover:underline">View payins</Link> : c.label === "Today's Payout" && payout.data ? <Link href="/admin/transactions/payout" className="hover:underline">View payouts</Link> : c.label === 'Settlements in Transit' && transit.data ? <Link href="/admin/settlements" className="hover:underline">{transit.data.data.length} awaiting bank confirmation</Link> : c.label in live ? 'From the ledger' : `Live from Phase ${c.phase}`}
          />
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {[
          { title: 'Merchants', body: 'Create merchant shells, suspend or reactivate accounts.', href: '/admin/merchants' },
          { title: 'Users & Roles', body: 'Platform staff, tenant members and the permission matrix.', href: '/admin/users' },
          { title: 'Audit Logs', body: 'Immutable trail of every privileged action and sign-in.', href: '/admin/audit-logs' },
        ].map((q) => (
          <Link key={q.href} href={q.href} className="group">
            <Card className="group-hover:border-primary/40 h-full shadow-none transition-colors">
              <CardHeader>
                <CardTitle className="text-base">{q.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">{q.body}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
