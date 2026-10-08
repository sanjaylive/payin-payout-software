'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { Disputes } from '@/features/disputes/disputes';

export default function AdminDisputesPage() {
  return (
    <>
      <PageHeader title="Disputes & chargebacks" description="Open a dispute from a bank notice (the amount is held), follow the merchant's evidence, and record the outcome." />
      <Suspense>
        <Disputes admin />
      </Suspense>
    </>
  );
}
