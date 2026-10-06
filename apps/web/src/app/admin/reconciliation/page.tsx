'use client';

import { PageHeader } from '@/components/common/page-header';
import { Reconciliation } from '@/features/reconciliation/reconciliation';

export default function ReconciliationPage() {
  return (
    <>
      <PageHeader title="Reconciliation" description="Match provider statements against Pay2All records. Exceptions are resolved by people; matching never moves money on its own." />
      <Reconciliation />
    </>
  );
}
