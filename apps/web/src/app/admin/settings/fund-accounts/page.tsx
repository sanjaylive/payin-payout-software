'use client';

import { PageHeader } from '@/components/common/page-header';
import { FundAccounts } from '@/features/funds/fund-accounts';

export default function FundAccountsPage() {
  return (
    <>
      <PageHeader level={2} title="Fund accounts" description="Bank accounts and UPI IDs merchants pay into to load their wallet." />
      <FundAccounts />
    </>
  );
}
