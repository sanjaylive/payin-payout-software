'use client';

import { useParams } from 'next/navigation';
import { VendorDetail } from '@/features/vendors/vendor-detail';

export default function VendorPage() {
  const { id } = useParams<{ id: string }>();
  return <VendorDetail id={id} />;
}
