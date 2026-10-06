'use client';

import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/common/page-header';
import { fmt } from '@/features/ledger/format';
import { AccountStatement } from '@/features/ledger/statement';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { LedgerAccount } from '@/lib/api/types';

export default function LedgerAccountPage() {
  const { id } = useParams<{ id: string }>();
  const account = useQuery({ queryKey: ['ledger-account', id], queryFn: () => api.get<LedgerAccount>(`/v1/ledger/accounts/${id}`) });
  if (account.isPending) return <LoadingSkeleton />;
  if (account.isError) return <ErrorState message={errorMessage(account.error)} />;
  const a = account.data;
  return (
    <>
      <Link href="/admin/ledger/accounts" className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1 text-sm"><ArrowLeft className="size-4" /> Accounts</Link>
      <PageHeader
        title={a.name}
        description={<span className="font-mono text-xs">{a.code}</span>}
        actions={<div className="text-right"><StatusBadge status={a.type} tone="neutral" /><p className="tabular mt-1 text-2xl font-semibold">{a.maintained ? fmt(a.balance) : 'Aggregated'}</p></div>}
      />
      <AccountStatement account={a} />
    </>
  );
}
