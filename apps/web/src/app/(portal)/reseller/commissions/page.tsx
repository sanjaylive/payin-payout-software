'use client';

import { PageHeader } from '@/components/common/page-header';
import { CommissionsByMerchant } from '@/features/resellers/earnings';
import { useMe } from '@/lib/auth/use-me';

export default function ResellerCommissionsPage() {
  const { data: me } = useMe();
  return (
    <>
      <PageHeader title="Commissions" description="What each of your merchants earned you this month." />
      {me && <CommissionsByMerchant resellerId={me.organization.id} />}
    </>
  );
}
