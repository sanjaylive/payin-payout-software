'use client';

import { useParams } from 'next/navigation';
import { PublicReceipt } from '@/features/agents/public-receipt';

export default function PublicReceiptPage() {
  const { token } = useParams<{ token: string }>();
  return <PublicReceipt token={token} />;
}
