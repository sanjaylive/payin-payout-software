'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { OrganizationsTable } from '@/features/organizations-table';

export default function AdminRESELLERPage() {
  return (
    <>
      <PageHeader title="Resellers" description="Partners who onboard and manage their own merchants." />
      <Suspense>
        <OrganizationsTable type="RESELLER" />
      </Suspense>
    </>
  );
}
