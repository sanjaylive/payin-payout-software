'use client';

import { PageHeader } from '@/components/common/page-header';
import { PayoutsTable } from '@/features/payout/payouts-table';

export default function PartnerPayoutPage() {
  return (
    <>
      <PageHeader title="Payout" description="Payouts across your merchants." />
      <PayoutsTable />
    </>
  );
}
