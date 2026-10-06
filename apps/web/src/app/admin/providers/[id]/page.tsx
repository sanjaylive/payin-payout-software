'use client';

import { useParams } from 'next/navigation';
import { ProviderDetail } from '@/features/providers/provider-detail';

export default function ProviderPage() {
  const { id } = useParams<{ id: string }>();
  return <ProviderDetail id={id} />;
}
