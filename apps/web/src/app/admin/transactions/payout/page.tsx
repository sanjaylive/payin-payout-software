'use client';

import { DateRangeFilter, presetRange } from '@pay2all/ui/components/date-range-filter';
import { Tabs, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { PayoutChart, PayoutStatCards } from '@/features/payout/payout-overview';
import { PayoutsTable } from '@/features/payout/payouts-table';

export default function AdminPayoutPage() {
  const [range, setRange] = useState(() => presetRange('today'));
  const [view, setView] = useState<'all' | 'review'>('all');
  return (
    <>
      <PageHeader title="Payout transactions" description="All payouts across merchants with routing attempts. Unknown outcomes wait in manual review — never re-sent automatically." actions={<DateRangeFilter value={range} onChange={setRange} />} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2"><PayoutStatCards range={range} /></div>
      <div className="mb-6"><PayoutChart range={range} /></div>
      <Tabs value={view} onValueChange={(v) => setView(v as 'all' | 'review')} className="mb-4">
        <TabsList><TabsTrigger value="all">All payouts</TabsTrigger><TabsTrigger value="review">Manual review</TabsTrigger></TabsList>
      </Tabs>
      {view === 'all' ? <PayoutsTable internal /> : <PayoutsTable key="review" internal status="MANUAL_REVIEW" />}
    </>
  );
}
