'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect } from 'react';
import { apiRequest } from '@/lib/api/client';
import { type Brand, colorVars, DEFAULT_BRAND } from './brand';

export const BRAND_KEY = ['brand'];
const BrandContext = createContext<Brand>(DEFAULT_BRAND);

/** Brand from the server render, kept fresh on the client (a save in Settings updates it everywhere). */
export function BrandProvider({ initial, children }: { initial: Brand; children: ReactNode }) {
  const { data } = useQuery({ queryKey: BRAND_KEY, queryFn: () => apiRequest<Brand>('/v1/brand', { auth: false }).then((r) => r.data), initialData: initial, staleTime: 60_000 });
  const brand = data ?? initial;

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
