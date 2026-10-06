'use client';

import { StatCard } from '@pay2all/ui/components/stat-card';
import { ArrowDownToLine, Building2, Coins, Receipt } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { presetRange } from '@pay2all/ui/components/date-range-filter';
import Link from 'next/link';
import { fmt } from '@/features/ledger/format';
import { usePaymentStats } from '@/features/payin/payin-overview';
import { usePayoutStats } from '@/features/payout/payout-overview';
import { useEarnings } from '@/features/resellers/earnings';
import { useMe } from '@/lib/auth/use-me';

const weekRange = presetRange('7d');
const currentMonth = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);

export default function ResellerDashboard() {
  const { data: me } = useMe();
  const stats = usePaymentStats(weekRange);
  const payouts = usePayoutStats(weekRange);
  const earnings = useEarnings(me?.organization.type === 'RESELLER' ? me.organization.id : undefined, currentMonth);
  return (
    <>
      <PageHeader title={me?.organization.name ?? 'Reseller'} description="Your merchants, volumes and earnings." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Merchants" value="—" icon={Building2} hint="See Merchants" />
        <StatCard label="Payin volume (7 days)" value={stats.data ? fmt(stats.data.totals.success_amount) : '—'} loading={stats.isPending} icon={ArrowDownToLine} hint={<Link href="/reseller/payin" className="hover:underline">View payins</Link>} />
        <StatCard label="Commission payable" value={earnings.data ? fmt(earnings.data.payable_balance) : '—'} loading={earnings.isPending} icon={Coins} hint={<Link href="/reseller/earnings" className="hover:underline">{earnings.data ? `${fmt(earnings.data.accrued_this_month)} this month` : 'View earnings'}</Link>} />
        <StatCard label="Payouts (7 days)" value={payouts.data ? fmt(payouts.data.totals.success_amount) : '—'} loading={payouts.isPending} icon={Receipt} hint={<Link href="/reseller/payout" className="hover:underline">View payouts</Link>} />
      </div>
    </>
  );
}
