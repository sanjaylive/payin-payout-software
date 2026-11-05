'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { NewTransaction } from '@/features/agents/new-transaction';

function NewEntry() {
  const params = useSearchParams();
  const type = params.get('type');
  const customer = params.get('customer');
  // A new ?type or ?customer starts a fresh form (and a fresh idempotency key).
  return <NewTransaction key={`${type ?? ''}:${customer ?? ''}`} initialType={type} initialCustomerId={customer} />;
}

export default function NewTransactionPage() {
  return (
    <Suspense>
      <NewEntry />
    </Suspense>
  );
}
