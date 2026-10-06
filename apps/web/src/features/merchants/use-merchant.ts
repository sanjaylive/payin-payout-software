'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { MerchantApplication } from '@/lib/api/types';

export const merchantKey = (id: string) => ['merchant', id] as const;

export function useMerchant(id: string | undefined) {
  return useQuery({ queryKey: merchantKey(id ?? ''), queryFn: () => api.get<MerchantApplication>(`/v1/merchants/${id}`), enabled: Boolean(id) });
}

export function useInvalidateMerchant(id: string) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: merchantKey(id) }), qc.invalidateQueries({ queryKey: ['merchants'] })]);
}
