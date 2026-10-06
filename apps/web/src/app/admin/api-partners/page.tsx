'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { OrganizationsTable } from '@/features/organizations-table';

export default function AdminAPIPARTNERPage() {
  return (
    <>
      <PageHeader title="API Partners" description="Platforms integrating Pay2All through the API." />
      <Suspense>
        <OrganizationsTable type="API_PARTNER" />
      </Suspense>
    </>
  );
}
