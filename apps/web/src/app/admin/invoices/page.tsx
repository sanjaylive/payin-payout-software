'use client';

import { PageHeader } from '@/components/common/page-header';
import { InvoiceList } from '@/features/invoices/invoices';

export default function AdminInvoicesPage() {
  return (
    <>
      <PageHeader title="Tax invoices" description="Monthly GST invoices issued to merchants for platform fees. Issued automatically after each month; you can also issue a month now." />
      <InvoiceList base="/admin/invoices" admin />
    </>
  );
}
