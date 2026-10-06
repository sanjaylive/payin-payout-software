'use client';

import { PageHeader } from '@/components/common/page-header';
import { JournalsTable, LedgerHealth } from '@/features/ledger/admin-ledger';

export default function JournalsPage() {
  return (
    <>
      <PageHeader title="Journals" description="Immutable, balanced journals. Corrections are posted as reversals — nothing is ever edited or deleted." />
      <div className="space-y-6">
        <LedgerHealth />
        <JournalsTable />
      </div>
    </>
  );
}
