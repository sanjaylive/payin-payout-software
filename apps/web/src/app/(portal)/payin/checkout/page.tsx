'use client';

import { PageHeader } from '@/components/common/page-header';
import { CheckoutSessions } from '@/features/checkout/merchant-checkout';

export default function CheckoutPage() {
  return (
    <>
      <PageHeader title="Checkout" description="Hosted payment pages for your orders: UPI, cards, netbanking and wallets on one secure page." />
      <CheckoutSessions />
    </>
  );
}
