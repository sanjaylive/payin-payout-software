'use client';

import { PageHeader } from '@/components/common/page-header';
import { PaymentsTable } from '@/features/payin/payments-table';

export default function PartnerPayinPage() {
  return (
    <>
      <PageHeader title="Payin" description="Collections across your merchants." />
      <PaymentsTable />
    </>
  );
}
