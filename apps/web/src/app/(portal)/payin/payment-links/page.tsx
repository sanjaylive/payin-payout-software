'use client';

import { useState } from 'react';
import { Button } from '@pay2all/ui/components/ui/button';
import { Link2, X } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { CreatePayment } from '@/features/payin/create-payment';
import { PaymentsTable } from '@/features/payin/payments-table';
import { useCan } from '@/lib/auth/use-me';

export default function PaymentLinksPage() {
  const can = useCan();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Payment links"
        description="Shareable links for remote customers (SMS, WhatsApp, email)."
        actions={can('payin.create') && <Button variant={creating ? 'outline' : 'default'} onClick={() => setCreating((c) => !c)}>{creating ? <><X /> Close</> : <><Link2 /> New link</>}</Button>}
      />
      {creating && <div className="mb-6"><CreatePayment defaultMethod="PAYMENT_LINK" /></div>}
      <PaymentsTable method="PAYMENT_LINK" />
    </>
  );
}
