'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { FundRequestsAdmin } from '@/features/funds/fund-requests-admin';

export default function FundRequestsPage() {
  return (
    <>
      <PageHeader title="Fund requests" description="Merchants pay into a fund account and submit the UTR. Verify it against the statement, then approve to credit their wallet — or reject." />
      <Suspense>
        <FundRequestsAdmin />
      </Suspense>
    </>
  );
}
