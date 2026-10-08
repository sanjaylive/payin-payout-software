'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { HostedCheckout } from '@/features/checkout/hosted-checkout';

function Page() {
  const { token } = useParams<{ token: string }>();
  const params = useSearchParams();
  return <HostedCheckout token={token} returned={params.get('returned') === '1'} embed={params.get('embed') === 'popup'} />;
}

export default function CheckoutPage() {
  return (
    <Suspense>
      <Page />
    </Suspense>
  );
}
