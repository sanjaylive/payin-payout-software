'use client';

import { StatCard } from '@pay2all/ui/components/stat-card';
import { ErrorState } from '@pay2all/ui/components/states';
import { useQuery } from '@tanstack/react-query';
import { Hourglass, Landmark, Lock, PauseCircle, ShieldAlert, Wallet } from 'lucide-react';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantBalances } from '@/lib/api/types';
import { fmt } from './format';

export function useBalances(merchantId: string | undefined) {
  return useQuery({
    queryKey: ['balances', merchantId],
    queryFn: () => api.get<MerchantBalances>('/v1/ledger/balances', { merchant_id: merchantId }),
    enabled: Boolean(merchantId),
    refetchInterval: 30_000,
  });
}

/** Balance buckets derived from the ledger (never stored independently). */
export function BalanceCards({ merchantId }: { merchantId: string }) {
  const b = useBalances(merchantId);
  if (b.isError) return <ErrorState message={errorMessage(b.error)} onRetry={() => void b.refetch()} />;
  const d = b.data;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <StatCard label="Available" value={fmt(d?.available)} icon={Wallet} loading={b.isPending} hint="Spendable for payouts" />
      <StatCard label="Unsettled" value={fmt(d?.unsettled)} icon={Hourglass} loading={b.isPending} hint="Collected, awaiting settlement" />
      <StatCard label="Reserved" value={fmt(d?.reserved)} icon={Lock} loading={b.isPending} hint="Held for in-flight payouts" />
      <StatCard label="Pending" value={fmt(d?.pending)} icon={PauseCircle} loading={b.isPending} hint="On hold before settlement" />
      <StatCard label="Lien" value={fmt(d?.lien)} icon={ShieldAlert} loading={b.isPending} hint="Frozen for disputes or risk" />
      <StatCard label="Settled to date" value={fmt(d?.settled_to_date)} icon={Landmark} loading={b.isPending} hint="Paid out to your bank" />
    </div>
  );
}
