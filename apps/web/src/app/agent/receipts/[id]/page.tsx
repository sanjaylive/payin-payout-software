'use client';

import { useParams } from 'next/navigation';
import { AgentReceiptPage } from '@/features/agents/agent-receipt';

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  return <AgentReceiptPage id={id} />;
}
