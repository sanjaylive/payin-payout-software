'use client';

import { PageHeader } from '@/components/common/page-header';
import { PaymentPages } from '@/features/payin/payment-pages';

export default function PaymentPagesPage() {
  return (
    <>
      <PageHeader title="Payment pages" description="Reusable public pages for fees, donations, events and products — share one link or QR, collect from everyone." />
      <PaymentPages />
    </>
  );
}
