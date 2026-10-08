'use client';

import { PageHeader } from '@/components/common/page-header';
import { PaymentGateways } from '@/features/gateways/payment-gateways';

export default function PaymentGatewaysPage() {
  return (
    <>
      <PageHeader level={2} title="Payment gateways" description="Razorpay, Cashfree, Easebuzz, CCAvenue, HDFC SmartGateway, NTT DATA and PhonePe — connect with your credentials." />
      <PaymentGateways />
    </>
  );
}
