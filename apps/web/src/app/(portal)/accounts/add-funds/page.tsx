'use client';

import { PageHeader } from '@/components/common/page-header';
import { AddFunds } from '@/features/funds/add-funds';

export default function AddFundsPage() {
  return (
    <>
      <PageHeader title="Add funds" description="Top up your wallet for payouts: pay by UPI or bank transfer, then submit the payment reference." />
      <AddFunds />
    </>
  );
}
