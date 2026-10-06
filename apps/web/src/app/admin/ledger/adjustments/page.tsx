'use client';

import { PageHeader } from '@/components/common/page-header';
import { AdjustmentsConsole } from '@/features/ledger/adjustments';

export default function AdjustmentsPage() {
  return (
    <>
      <PageHeader title="Adjustments" description="Manual credits and debits with maker-checker approval. The maker can never approve their own adjustment." />
      <AdjustmentsConsole />
    </>
  );
}
