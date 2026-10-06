'use client';

import { PageHeader } from '@/components/common/page-header';
import { MerchantStatement } from '@/features/ledger/statement';
import { useMe } from '@/lib/auth/use-me';

export default function LedgerPage() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <>
      <PageHeader title="Ledger" description="Every movement on your account, with running balance. Click a row for the full journal." />
      <MerchantStatement merchantId={me.organization.id} />
    </>
  );
}
