'use client';

import { useParams } from 'next/navigation';
import { AdminAgentDetail } from '@/features/agents/admin/admin-agent-detail';

export default function AdminAgentPage() {
  const { id } = useParams<{ id: string }>();
  return <AdminAgentDetail id={id} />;
}
