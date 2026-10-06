'use client';

import { PageHeader } from '@/components/common/page-header';
import { CreatePayout } from '@/features/payout/create-payout';

export default function MakePayoutPage() {
  return (
    <>
      <PageHeader title="Make payout" description="Send money to a bank account (IMPS / NEFT / RTGS) or a UPI ID." />
      <CreatePayout />
    </>
  );
}
