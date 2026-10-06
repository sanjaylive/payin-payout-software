'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { QrCode } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { PaymentsTable } from '@/features/payin/payments-table';
import { useCan } from '@/lib/auth/use-me';

export default function QrCodesPage() {
  const can = useCan();
  return (
    <>
      <PageHeader
        title="QR codes"
        description="Single-use, amount-specific UPI QR codes. Each one expires after its payment window."
        actions={can('payin.create') && <Button asChild><Link href="/payin/create"><QrCode /> New QR</Link></Button>}
      />
      <PaymentsTable method="UPI_QR" />
    </>
  );
}
