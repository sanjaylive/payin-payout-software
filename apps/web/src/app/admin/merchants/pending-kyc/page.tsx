'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { MerchantsTable } from '@/features/merchants/merchants-table';

export default function ComplianceQueuePage() {
  return (
    <>
      <PageHeader title="Compliance queue" description="Applications submitted, under review, or waiting on the merchant." />
      <Suspense>
        <MerchantsTable detailBase="/admin/merchants" defaultTab="pending" hideTabs />
      </Suspense>
    </>
  );
}
