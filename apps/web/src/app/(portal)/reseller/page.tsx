'use client';

import { StatCard } from '@pay2all/ui/components/stat-card';
import { ArrowDownToLine, Building2, Coins, Receipt } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { useMe } from '@/lib/auth/use-me';

export default function ResellerDashboard() {
  const { data: me } = useMe();
  return (
    <>
      <PageHeader title={me?.organization.name ?? 'Reseller'} description="Your merchants, volumes and earnings." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Merchants" value="—" icon={Building2} hint="See Merchants" />
        <StatCard label="Payin volume" value="—" icon={ArrowDownToLine} hint="Live from Phase 5" />
        <StatCard label="Commission accrued" value="—" icon={Coins} hint="Live from Phase 9" />
        <StatCard label="Payouts" value="—" icon={Receipt} hint="Live from Phase 6" />
      </div>
    </>
  );
}
