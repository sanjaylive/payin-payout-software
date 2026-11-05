'use client';

import { useParams } from 'next/navigation';
import { CustomerDetailPage } from '@/features/agents/customers';

export default function AgentCustomerPage() {
  const { id } = useParams<{ id: string }>();
  return <CustomerDetailPage id={id} />;
}
