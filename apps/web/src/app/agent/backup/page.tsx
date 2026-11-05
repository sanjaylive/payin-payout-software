'use client';

import { Suspense } from 'react';
import { AgentBackup } from '@/features/agents/backup';

export default function AgentBackupPage() {
  return (
    <Suspense>
      <AgentBackup />
    </Suspense>
  );
}
