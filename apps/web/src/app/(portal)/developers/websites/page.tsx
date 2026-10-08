'use client';

import { PageHeader } from '@/components/common/page-header';
import { Websites } from '@/features/checkout/merchant-checkout';

export default function WebsitesPage() {
  return (
    <>
      <PageHeader title="Websites" description="The websites checkout may send your customers back to after they pay." />
      <Websites />
    </>
  );
}
