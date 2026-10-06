'use client';

import { PageHeader } from '@/components/common/page-header';
import { SettlementScheduleCard } from '@/features/settlements/settlement-config';
import { SettlementsTable } from '@/features/settlements/settlements';
import { useMe } from '@/lib/auth/use-me';

export default function SettlementsPage() {
  const { data: me } = useMe();
  const merchant = me?.organization.type === 'MERCHANT';
  return (
    <>
      <PageHeader title="Settlements" description="Money from successful payments, moved from unsettled to your wallet or bank on your schedule." />
      {merchant && <div className="mb-6"><SettlementScheduleCard merchantId={me.organization.id} /></div>}
      <SettlementsTable />
    </>
  );
}
