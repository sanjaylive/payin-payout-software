'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { ApiError, apiRequest } from '@/lib/api/client';
import type { AgentReceipt } from './api';
import { ReceiptView } from './receipt-view';

/** /r/<token>: the receipt a customer opens from the shared link. Shows nothing else about the shop. */
export function PublicReceipt({ token }: { token: string }) {
  const q = useQuery({
    queryKey: ['public-receipt', token],
    queryFn: () => apiRequest<AgentReceipt>(`/v1/public/agent-receipts/${encodeURIComponent(token)}`, { auth: false }).then((r) => r.data),
  });
  return (
    <main className="bg-muted/30 min-h-dvh px-4 py-8 print:bg-white print:p-0">
      {q.isError ? (
        <ErrorState
          className="min-h-[60dvh]"
          title={q.error instanceof ApiError && q.error.status === 404 ? 'Receipt not found' : 'Could not load the receipt'}
          message={q.error instanceof ApiError && q.error.status === 404 ? 'Check the link you were sent, or ask the shop to share it again.' : 'Please try again in a moment.'}
          onRetry={q.error instanceof ApiError && q.error.status === 404 ? undefined : () => void q.refetch()}
        />
      ) : !q.data ? (
        <Skeleton className="mx-auto h-[560px] w-full max-w-md rounded-2xl" />
      ) : (
        <div className="space-y-4">
          <ReceiptView receipt={q.data} />
          <div className="flex justify-center print:hidden">
            <Button variant="outline" size="lg" onClick={() => window.print()}>
              <Printer /> Print / save as PDF
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
