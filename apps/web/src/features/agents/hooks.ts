'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { AgentProfile } from './api';

/** Query keys under one root so a recorded transaction refreshes every view at once. */
export const AGENT_KEY = ['agent'] as const;
export const PROFILE_KEY = ['agent', 'profile'] as const;
export const DASHBOARD_KEY = ['agent', 'dashboard'] as const;
export const TXNS_KEY = ['agent', 'transactions'] as const;
export const CUSTOMERS_KEY = ['agent', 'customers'] as const;
export const BILLING_KEY = ['agent', 'billing'] as const;

export function useAgentProfile() {
  return useQuery({ queryKey: PROFILE_KEY, queryFn: () => api.get<AgentProfile>('/v1/agent/profile'), staleTime: 60_000 });
}
