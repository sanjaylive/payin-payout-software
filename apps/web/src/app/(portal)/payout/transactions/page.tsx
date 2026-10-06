'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Send } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { PayoutsTable } from '@/features/payout/payouts-table';
import { useCan } from '@/lib/auth/use-me';

export default function PayoutTransactionsPage() {
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Payout transactions"
        description="Every transfer, its approvals and bank reference. Click a row for details."
        actions={can('payout.create') && <Button asChild><Link href="/payout/create"><Send /> Make payout</Link></Button>}
      />
      <PayoutsTable />
    </>
  );
}
