'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { TransactionsList } from '@/features/agents/transactions';
import { useCan } from '@/lib/auth/use-me';

export default function AgentTransactionsPage() {
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every entry recorded at your counter. Tap one for its receipt."
        actions={
          can('agent.desk.write') ? (
            <Button asChild>
              <Link href="/agent/new">
                <Plus /> New entry
              </Link>
            </Button>
          ) : undefined
        }
      />
      <TransactionsList />
    </>
  );
}
