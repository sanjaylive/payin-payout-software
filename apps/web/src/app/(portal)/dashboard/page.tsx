'use client';

import { DateRangeFilter, presetRange } from '@pay2all/ui/components/date-range-filter';
import { StatCard } from '@pay2all/ui/components/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Hourglass, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { useBalances } from '@/features/ledger/balance-cards';
import { fmt } from '@/features/ledger/format';
import { PayinCharts, PayinStatCards } from '@/features/payin/payin-overview';
import { PayoutChart, PayoutStatCards } from '@/features/payout/payout-overview';
import { useMe } from '@/lib/auth/use-me';

/**
 * Merchant dashboard. Payin metrics are live (Phase 5); values for modules that don't exist yet stay
 * empty — the dashboard never shows invented numbers. Each such card names the phase that wires it.
 */
export default function MerchantDashboard() {
  const { data: me } = useMe();
  const [range, setRange] = useState(() => presetRange('today'));
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
        {isMerchant && <PayoutStatCards range={range} approvalsHref="/payout/approvals" />}
        <StatCard label="Available Balance" value={isMerchant ? fmt(balances.data?.available) : '—'} loading={isMerchant && balances.isPending} icon={Wallet} hint={<Link href="/accounts/balance" className="hover:underline">View balances</Link>} />
        <StatCard label="Unsettled Balance" value={isMerchant ? fmt(balances.data?.unsettled) : '—'} loading={isMerchant && balances.isPending} icon={Hourglass} hint={<Link href="/settlements" className="hover:underline">Settlement schedule</Link>} />
      </div>
      {isMerchant && <div className="mt-6"><PayinCharts range={range} /></div>}
      {isMerchant && <div className="mt-6"><PayoutChart range={range} /></div>}
      <Card className="mt-6 shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Get ready to go live</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p>1. Complete your <Link href="/compliance/profile" className="text-primary font-medium hover:underline">business profile and KYC documents</Link> under Compliance.</p>
          <p>2. Invite your team from <Link href="/team" className="text-primary font-medium hover:underline">Team</Link> and enable two-factor authentication in <Link href="/settings/security" className="text-primary font-medium hover:underline">Settings</Link>.</p>
          <p>3. <Link href="/payin/create" className="text-primary font-medium hover:underline">Create a test payment</Link> to see the QR, live status and ledger credit end to end.</p>
          <p>4. <Link href="/payout/beneficiaries" className="text-primary font-medium hover:underline">Add and verify a beneficiary</Link>, then make a payout; larger ones go to a teammate for approval.</p>
          <p>5. Generate API keys and configure webhooks under Developers once your account is approved.</p>
        </CardContent>
      </Card>
    </>
  );
}
