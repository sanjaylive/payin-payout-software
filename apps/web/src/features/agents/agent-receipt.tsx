'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import type { AgentReceipt } from './api';
import { TXNS_KEY } from './hooks';
import { ReceiptActions } from './receipt-actions';
import { ReceiptView } from './receipt-view';

/** /agent/receipts/<id>: the printable receipt with share actions. */
export function AgentReceiptPage({ id }: { id: string }) {
  const can = useCan();
  const q = useQuery({ queryKey: [...TXNS_KEY, id, 'receipt'], queryFn: () => api.get<AgentReceipt>(`/v1/agent/transactions/${id}/receipt`) });
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/agent/transactions">
            <ArrowLeft /> Transactions
          </Link>
        </Button>
        {can('agent.desk.write') && (
          <Button size="sm" asChild>
            <Link href="/agent/new">
              <Plus /> New entry
            </Link>
          </Button>
        )}
      </div>
      {q.data ? (
        <>
          <ReceiptView receipt={q.data} />
          <ReceiptActions receipt={q.data} className="mx-auto max-w-md sm:justify-center print:hidden" />
        </>
      ) : (
        <Skeleton className="mx-auto h-[560px] max-w-md rounded-2xl" />
      )}
    </div>
  );
}
