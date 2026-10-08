'use client';

import { PageHeader } from '@/components/common/page-header';
import { WebsiteReviews } from '@/features/checkout/merchant-checkout';

export default function WebsiteReviewsPage() {
  return (
    <>
      <PageHeader title="Merchant websites" description="Approve the websites merchants use with hosted checkout." />
      <WebsiteReviews />
    </>
  );
}
