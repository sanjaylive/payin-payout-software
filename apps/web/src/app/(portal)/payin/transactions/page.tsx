'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { PaymentsTable } from '@/features/payin/payments-table';
import { useCan } from '@/lib/auth/use-me';

export default function PayinTransactionsPage() {
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Payin transactions"
        description="Every collection, its bank reference and the fee charged. Click a row for details and refunds."
        actions={can('payin.create') && <Button asChild><Link href="/payin/create"><Plus /> Create payment</Link></Button>}
      />
      <PaymentsTable />
    </>
  );
}
