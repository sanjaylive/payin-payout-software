'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { MerchantsTable } from '@/features/merchants/merchants-table';

export default function PartnerMerchantsPage() {
  return (
    <>
      <PageHeader title="Merchants" description="Merchants integrated through your platform." />
      <Suspense>
        <MerchantsTable detailBase="/partner/merchants" />
      </Suspense>
    </>
  );
}
