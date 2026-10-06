'use client';

import { PageHeader } from '@/components/common/page-header';
import { SalesLeads } from '@/features/sales-leads';

export default function SalesPage() {
  return (
    <>
      <PageHeader title="Sales leads" description="Prospects, follow-ups and conversions into merchant applications." />
      <SalesLeads />
    </>
  );
}
