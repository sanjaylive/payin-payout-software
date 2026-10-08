'use client';

import { PageHeader } from '@/components/common/page-header';
import { PaymentLinks } from '@/features/payin/payment-links';

export default function PaymentLinksPage() {
  return (
    <>
      <PageHeader title="Payment links" description="Request money from anyone. Share by WhatsApp, SMS, email or QR — customers pay by UPI or card and get a receipt." />
      <PaymentLinks />
    </>
  );
}
