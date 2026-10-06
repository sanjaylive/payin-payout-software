'use client';

import { PageHeader } from '@/components/common/page-header';
import { PricingAssignments } from '@/features/pricing/pricing-assignments';

export default function MerchantPricingPage() {
  return (
    <>
      <PageHeader title="Merchant pricing" description="Assign plans to merchants and resellers, and check what a transaction would cost." />
      <PricingAssignments />
    </>
  );
}
