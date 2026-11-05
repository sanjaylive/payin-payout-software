'use client';

import type { ReactNode } from 'react';
import { AuthGate } from '@/components/auth/auth-gate';
import { AgentShell } from '@/features/agents/agent-shell';

/** Agent (customer service point) counter — agent accounts only (docs/AGENTS.md). */
export default function AgentLayout({ children }: { children: ReactNode }) {
  return <AuthGate allow={['AGENT']}>{(me) => <AgentShell me={me}>{children}</AgentShell>}</AuthGate>;
}
