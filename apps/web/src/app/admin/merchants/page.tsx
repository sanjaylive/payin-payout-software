'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { MerchantsTable } from '@/features/merchants/merchants-table';

export default function AdminMerchantsPage() {
  return (
    <>
      <PageHeader title="Merchants" description="All merchant accounts across Pay2All and its resellers." />
      <Suspense>
        <MerchantsTable detailBase="/admin/merchants" />
      </Suspense>
    </>
  );
}
