'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { HostedCheckout } from '@/features/checkout/hosted-checkout';

function Page() {
  const { token } = useParams<{ token: string }>();
  const returned = useSearchParams().get('returned') === '1';
  return <HostedCheckout token={token} returned={returned} />;
}

export default function CheckoutPage() {
  return (
    <Suspense>
      <Page />
    </Suspense>
  );
}
