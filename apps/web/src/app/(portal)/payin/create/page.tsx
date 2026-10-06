'use client';

import { PageHeader } from '@/components/common/page-header';
import { CreatePayment } from '@/features/payin/create-payment';

export default function CreatePaymentPage() {
  return (
    <>
      <PageHeader title="Create payment" description="Collect via UPI — show the QR to your customer or share the link." />
      <CreatePayment />
    </>
  );
}
