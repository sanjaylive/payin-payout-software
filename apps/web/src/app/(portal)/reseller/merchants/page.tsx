'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { MerchantsTable } from '@/features/merchants/merchants-table';

export default function ResellerMerchantsPage() {
  return (
    <>
      <PageHeader title="Merchants" description="Merchants onboarded through your reseller account." />
      <Suspense>
        <MerchantsTable detailBase="/reseller/merchants" />
      </Suspense>
    </>
  );
}
