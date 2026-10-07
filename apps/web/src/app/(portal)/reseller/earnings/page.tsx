'use client';

import { PageHeader } from '@/components/common/page-header';
import { EarningsOverview } from '@/features/resellers/earnings';
import { useMe } from '@/lib/auth/use-me';

export default function ResellerEarningsPage() {
  const { data: me } = useMe();
  return (
    <>
      <PageHeader title="Earnings" description="Commission accrued to you and what Pay2All has paid out." />
      {me && <EarningsOverview resellerId={me.organization.id} />}
    </>
  );
}
