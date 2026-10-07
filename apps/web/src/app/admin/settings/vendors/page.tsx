'use client';

import { PageHeader } from '@/components/common/page-header';
import { VendorsList } from '@/features/vendors/vendors-list';

export default function VendorsPage() {
  return (
    <>
      <PageHeader level={2} title="API vendors" description="Companies Pay2All integrates with — banks and payment partners for payin and payout, gateways for SMS, WhatsApp and email." />
      <VendorsList />
    </>
  );
}
