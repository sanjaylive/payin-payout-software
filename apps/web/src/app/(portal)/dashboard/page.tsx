'use client';

import { DateRangeFilter, presetRange } from '@pay2all/ui/components/date-range-filter';
import { EmptyState } from '@pay2all/ui/components/states';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { ArrowUpFromLine, ChartColumn, Hourglass, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { useBalances } from '@/features/ledger/balance-cards';
import { fmt } from '@/features/ledger/format';
import { PayinCharts, PayinStatCards } from '@/features/payin/payin-overview';
import { useMe } from '@/lib/auth/use-me';

/**
 * Merchant dashboard. Payin metrics are live (Phase 5); values for modules that don't exist yet stay
 * empty — the dashboard never shows invented numbers. Each such card names the phase that wires it.
 */
export default function MerchantDashboard() {
  const { data: me } = useMe();
  const [range, setRange] = useState(() => presetRange('today'));
  const pending = (phase: number) => `Live from Phase ${phase}`;
  const isMerchant = me?.organization.type === 'MERCHANT';
  const balances = useBalances(isMerchant ? me.organization.id : undefined);

  return (
    <>
      <PageHeader
        title={`Welcome, ${me?.user.name.split(' ')[0] ?? ''}`}
        description="Collections, payouts and balances at a glance."
        actions={<DateRangeFilter value={range} onChange={setRange} />}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {isMerchant && <PayinStatCards range={range} />}
        <StatCard label="Today's Payout" value="—" icon={ArrowUpFromLine} hint={pending(6)} />
        <StatCard label="Available Balance" value={isMerchant ? fmt(balances.data?.available) : '—'} loading={isMerchant && balances.isPending} icon={Wallet} hint={<Link href="/accounts/balance" className="hover:underline">View balances</Link>} />
        <StatCard label="Unsettled Balance" value={isMerchant ? fmt(balances.data?.unsettled) : '—'} loading={isMerchant && balances.isPending} icon={Hourglass} hint="Settles on your cycle" />
      </div>
      {isMerchant && <div className="mt-6"><PayinCharts range={range} /></div>}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {['Payout volume'].map((title) => (
          <Card key={title} className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <EmptyState icon={ChartColumn} title="Payouts arrive in Phase 6" description="This chart populates once payouts flow through your account." className="py-8" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="mt-6 shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Get ready to go live</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p>1. Complete your <Link href="/compliance/profile" className="text-primary font-medium hover:underline">business profile and KYC documents</Link> under Compliance.</p>
          <p>2. Invite your team from <Link href="/team" className="text-primary font-medium hover:underline">Team</Link> and enable two-factor authentication in <Link href="/settings/security" className="text-primary font-medium hover:underline">Settings</Link>.</p>
          <p>3. <Link href="/payin/create" className="text-primary font-medium hover:underline">Create a test payment</Link> to see the QR, live status and ledger credit end to end.</p>
          <p>4. Generate API keys and configure webhooks under Developers once your account is approved.</p>
        </CardContent>
      </Card>
    </>
  );
}
