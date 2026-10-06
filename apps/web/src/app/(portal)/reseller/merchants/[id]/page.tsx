'use client';

import { useParams } from 'next/navigation';
import { MerchantDetail } from '@/features/merchants/merchant-detail';

export default function ResellerMerchantDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <MerchantDetail merchantId={id} backHref="/reseller/merchants" />;
}
