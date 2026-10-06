'use client';

import { useParams } from 'next/navigation';
import { MerchantDetail } from '@/features/merchants/merchant-detail';

export default function AdminMerchantDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <MerchantDetail merchantId={id} backHref="/admin/merchants" />;
}
