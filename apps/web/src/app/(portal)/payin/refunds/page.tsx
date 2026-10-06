'use client';

import { PageHeader } from '@/components/common/page-header';
import { RefundsTable } from '@/features/payin/refunds-table';

export default function RefundsPage() {
  return (
    <>
      <PageHeader title="Refunds" description="Refunds you have initiated. To refund, open a successful payment and choose Refund." />
      <RefundsTable />
    </>
  );
}
