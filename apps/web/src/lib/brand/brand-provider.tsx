'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect } from 'react';
import { apiRequest } from '@/lib/api/client';
import { useAuthStore } from '@/lib/auth/store';
import { type Brand, colorVars, DEFAULT_BRAND } from './brand';

export const BRAND_KEY = ['brand'];
const BrandContext = createContext<Brand>(DEFAULT_BRAND);

/**
 * Brand from the server render (by host), kept fresh on the client. Once signed in, the brand of the
 * user's organization wins: a reseller's users and its merchants' users see its white-label brand.
 */
export function BrandProvider({ initial, children }: { initial: Brand; children: ReactNode }) {
  const { data } = useQuery({
    queryKey: BRAND_KEY,
    queryFn: () => apiRequest<Brand>('/v1/brand', { auth: false, query: { host: window.location.host } }).then((r) => r.data),
    initialData: initial,
    staleTime: 60_000,
  });
  const signedIn = useAuthStore((s) => Boolean(s.accessToken));
  const mine = useQuery({ queryKey: [...BRAND_KEY, 'mine'], queryFn: () => apiRequest<Brand>('/v1/brand/mine').then((r) => r.data), enabled: signedIn, staleTime: 60_000 });
  const brand = (signedIn ? mine.data : undefined) ?? data ?? initial;

  // The colour lives on <html> (outside React's tree), so it is synced as an external system.
  useEffect(() => {
    const root = document.documentElement;
    const vars = colorVars(brand.primary_color);
    for (const k of ['--brand-primary', '--brand-primary-fg', '--brand-primary-dark', '--brand-primary-dark-fg']) root.style.removeProperty(k);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    if (brand.primary_color) root.setAttribute('data-brand-color', '');
    else root.removeAttribute('data-brand-color');
  }, [brand.primary_color]);

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export const useBrand = () => useContext(BrandContext);
