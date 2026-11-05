'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Me } from '../api/types';
import { useAuthStore } from './store';

export const ME_QUERY_KEY = ['auth', 'me'] as const;

export function useMe() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({ queryKey: ME_QUERY_KEY, queryFn: () => api.get<Me>('/v1/auth/me'), enabled: Boolean(token), staleTime: 60_000 });
}

/** Merchants still filling in their application land on the onboarding wizard. */
const ONBOARDING_STATUSES = ['DRAFT', 'MORE_INFORMATION_REQUIRED'];

export function homePathFor(me: Pick<Me, 'organization' | 'session'> & Partial<Pick<Me, 'onboarding'>>): string {
  if (me.session.restricted) return '/setup-mfa';
  // Agents (customer service points) have no KYB onboarding; they go straight to the counter.
  if (me.organization.type === 'AGENT') return '/agent';
  if (me.onboarding && ONBOARDING_STATUSES.includes(me.onboarding.status)) return '/onboarding';
  switch (me.organization.type) {
    case 'PLATFORM':
      return '/admin';
    case 'RESELLER':
      return '/reseller';
    case 'API_PARTNER':
      return '/partner';
    default:
      return '/dashboard';
  }
}

export function useCan() {
  const { data } = useMe();
  return (permission: string) => Boolean(data?.permissions.includes(permission));
}
