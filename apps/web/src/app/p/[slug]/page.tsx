'use client';

import { useParams } from 'next/navigation';
import { PublicPaymentPageView } from '@/features/checkout/public-page';

export default function PaymentPageRoute() {
  const { slug } = useParams<{ slug: string }>();
  return <PublicPaymentPageView slug={slug} />;
}
