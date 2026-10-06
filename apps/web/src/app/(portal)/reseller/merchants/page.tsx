'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { OrganizationsTable } from '@/features/organizations-table';

export default function ResellerMerchantsPage() {
  return (
    <>
      <PageHeader title="Merchants" description="Merchants onboarded through your reseller account." />
      <Suspense>
        <OrganizationsTable type="MERCHANT" allowCreate={false} />
      </Suspense>
    </>
  );
}
