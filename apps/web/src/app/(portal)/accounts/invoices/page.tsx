'use client';

import { PageHeader } from '@/components/common/page-header';
import { InvoiceList } from '@/features/invoices/invoices';

export default function InvoicesPage() {
  return (
    <>
      <PageHeader title="Tax invoices" description="Monthly GST invoices for the platform fees charged on your transactions." />
      <InvoiceList base="/accounts/invoices" />
    </>
  );
}
