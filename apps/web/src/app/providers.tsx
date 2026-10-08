'use client';

import { TooltipProvider } from '@pay2all/ui/components/ui/tooltip';
import { Toaster } from '@pay2all/ui/components/ui/sonner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { type ReactNode, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import type { Brand } from '@/lib/brand/brand';
import { BrandProvider } from '@/lib/brand/brand-provider';

export function Providers({ children, nonce, brand }: { children: ReactNode; nonce?: string; brand: Brand }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // Client errors (4xx) are deterministic — retrying just repeats the failure.
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange nonce={nonce}>
      <QueryClientProvider client={queryClient}>
        <BrandProvider initial={brand}>
          <TooltipProvider delayDuration={200}>
            {children}
            <Toaster richColors position="top-right" />
          </TooltipProvider>
        </BrandProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
