'use client';

import { useParams } from 'next/navigation';
import { InvoiceView } from '@/features/invoices/invoices';

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  return <InvoiceView id={id} />;
}
