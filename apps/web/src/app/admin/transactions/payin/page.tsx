'use client';

import { DateRangeFilter, presetRange } from '@pay2all/ui/components/date-range-filter';
import { useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { PayinCharts, PayinStatCards } from '@/features/payin/payin-overview';
import { PaymentsTable } from '@/features/payin/payments-table';

export default function AdminPayinPage() {
  const [range, setRange] = useState(() => presetRange('today'));
  return (
    <>
      <PageHeader title="Payin transactions" description="All collections across merchants, with provider routing and attempts." actions={<DateRangeFilter value={range} onChange={setRange} />} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3"><PayinStatCards range={range} /></div>
      <div className="mb-6"><PayinCharts range={range} /></div>
      <PaymentsTable internal />
    </>
  );
}
