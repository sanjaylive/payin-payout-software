'use client';

import { PageHeader } from '@/components/common/page-header';
import { PricingPlans } from '@/features/pricing/pricing-plans';

export default function PricingPage() {
  return (
    <>
      <PageHeader title="Pricing plans" description="Merchant, reseller-wholesale and provider-cost plans. Every transaction snapshots the exact pricing it was charged." />
      <PricingPlans />
    </>
  );
}
