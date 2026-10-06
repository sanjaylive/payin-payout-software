'use client';

import { PageHeader } from '@/components/common/page-header';
import { RefundsTable } from '@/features/payin/refunds-table';

export default function AdminRefundsPage() {
  return (
    <>
      <PageHeader title="Refunds" description="Refunds across merchants. Ambiguous provider outcomes land in Manual review — they are never reversed blindly." />
      <RefundsTable />
    </>
  );
}
