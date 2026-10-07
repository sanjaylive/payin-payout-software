'use client';

import { PageHeader } from '@/components/common/page-header';
import { PricingProviders } from '@/features/schemes/pricing-providers';

export default function PricingProvidersPage() {
  return (
    <>
      <PageHeader level={2} title="Pricing providers" description="The numbered pricing lines that schemes charge or pay commission on." />
      <PricingProviders />
    </>
  );
}
