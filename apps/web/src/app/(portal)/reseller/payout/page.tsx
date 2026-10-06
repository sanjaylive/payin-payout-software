'use client';

import { DateRangeFilter, presetRange } from '@pay2all/ui/components/date-range-filter';
import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { PayoutChart, PayoutStatCards } from '@/features/payout/payout-overview';
import { PayoutsTable } from '@/features/payout/payouts-table';

export default function ResellerPayoutPage() {
  const [range, setRange] = useState(() => presetRange('7d'));
  return (
    <>
      <PageHeader title="Payout" description="Payouts across your merchants." actions={<DateRangeFilter value={range} onChange={setRange} />} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2"><PayoutStatCards range={range} /></div>
      <div className="mb-6"><PayoutChart range={range} /></div>
      <PayoutsTable />
    </>
  );
}
