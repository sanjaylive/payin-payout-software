'use client';

import { DateRangeFilter, presetRange } from '@pay2all/ui/components/date-range-filter';
import { EmptyState } from '@pay2all/ui/components/states';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { ArrowDownToLine, ArrowUpFromLine, ChartColumn, CircleCheck, Hourglass, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { useMe } from '@/lib/auth/use-me';

/**
 * Merchant dashboard. Metric values stay empty until the modules that produce them exist — the
 * dashboard never shows invented numbers. Each card names the phase that wires it to live data.
 */
export default function MerchantDashboard() {
  const { data: me } = useMe();
  const [range, setRange] = useState(() => presetRange('today'));
  const pending = (phase: number) => `Live from Phase ${phase}`;

  return (
    <>
      <PageHeader
        title={`Welcome, ${me?.user.name.split(' ')[0] ?? ''}`}
        description="Collections, payouts and balances at a glance."
        actions={<DateRangeFilter value={range} onChange={setRange} />}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Today's Payin" value="—" icon={ArrowDownToLine} hint={pending(5)} />
        <StatCard label="Today's Payout" value="—" icon={ArrowUpFromLine} hint={pending(6)} />
        <StatCard label="Available Balance" value="—" icon={Wallet} hint={pending(3)} />
        <StatCard label="Unsettled Balance" value="—" icon={Hourglass} hint={pending(3)} />
        <StatCard label="Payin Success Rate" value="—" icon={CircleCheck} hint={pending(5)} />
        <StatCard label="Payout Success Rate" value="—" icon={CircleCheck} hint={pending(6)} />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {['Payin volume', 'Payout volume', 'Transaction count', 'Success vs failure'].map((title) => (
          <Card key={title} className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <EmptyState icon={ChartColumn} title="No transactions yet" description="Charts populate once payins and payouts flow through your account." className="py-8" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="mt-6 shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Get ready to go live</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p>1. Complete your business profile and KYC documents under Compliance.</p>
          <p>2. Invite your team from <Link href="/team" className="text-primary font-medium hover:underline">Team</Link> and enable two-factor authentication in <Link href="/settings/security" className="text-primary font-medium hover:underline">Settings</Link>.</p>
          <p>3. Generate API keys and configure webhooks under Developers once your account is approved.</p>
        </CardContent>
      </Card>
    </>
  );
}
