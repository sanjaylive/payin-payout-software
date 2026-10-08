'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { Disputes } from '@/features/disputes/disputes';

export default function DisputesPage() {
  return (
    <>
      <PageHeader title="Disputes" description="Chargebacks raised by your customers' banks. Upload evidence before the deadline to contest them; the amount is on hold until each is decided." />
      <Suspense>
        <Disputes />
      </Suspense>
    </>
  );
}
