'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { OrganizationsTable } from '@/features/organizations-table';

export default function AdminMERCHANTPage() {
  return (
    <>
      <PageHeader title="Merchants" description="All merchant accounts across Pay2All and its resellers." />
      <Suspense>
        <OrganizationsTable type="MERCHANT" />
      </Suspense>
    </>
  );
}
