'use client';

import { DateRangeFilter, presetRange } from '@pay2all/ui/components/date-range-filter';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { ApiUsageOverview } from '@/features/developers/api-logs';
import { PayinStatCards } from '@/features/payin/payin-overview';
import { PayoutStatCards } from '@/features/payout/payout-overview';
import { useMe } from '@/lib/auth/use-me';

export default function PartnerDashboard() {
  const { data: me } = useMe();
  const [range, setRange] = useState(() => presetRange('7d'));
  return (
    <>
      <PageHeader title={me?.organization.name ?? 'API partner'} description="Your merchants' collections and payouts, and your API integration's health." actions={<DateRangeFilter value={range} onChange={setRange} />} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <PayinStatCards range={range} />
        <PayoutStatCards range={range} />
      </div>
      <h2 className="mt-8 mb-3 text-lg font-semibold">API</h2>
      <ApiUsageOverview />
      <Card className="mt-6 shadow-none">
        <CardHeader><CardTitle className="text-base">Acting for your merchants</CardTitle></CardHeader>
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p>Create merchants under <Link href="/partner/merchants" className="text-primary hover:underline">Merchants</Link>; each completes KYC before it can transact.</p>
          <p>Sign API calls with your partner key and add <code>X-Pay2All-Merchant: org_…</code> to act for one of your merchants. Requests for merchants outside your account are rejected.</p>
        </CardContent>
      </Card>
    </>
  );
}
