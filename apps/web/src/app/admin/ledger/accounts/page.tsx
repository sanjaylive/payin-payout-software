'use client';

import { PageHeader } from '@/components/common/page-header';
import { LedgerAccountsTable, LedgerHealth } from '@/features/ledger/admin-ledger';

export default function LedgerAccountsPage() {
  return (
    <>
      <PageHeader title="Ledger accounts" description="Chart of accounts. Merchant accounts keep locked running balances; hot platform accounts are aggregated from entries." />
      <div className="space-y-6">
        <LedgerHealth />
        <LedgerAccountsTable />
      </div>
    </>
  );
}
