'use client';

import { PageHeader } from '@/components/common/page-header';
import { RateCards } from '@/features/resellers/rate-cards';

export default function ResellerPricingPage() {
  return (
    <>
      <PageHeader title="Pricing" description="Rate cards for your merchants. Your margin is what you charge minus your wholesale price." />
      <RateCards />
    </>
  );
}
