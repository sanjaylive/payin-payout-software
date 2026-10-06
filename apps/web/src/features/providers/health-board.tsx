'use client';

import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { ProviderRow } from '@/lib/api/types';
import { healthFor, ms, pct, ProviderStatus } from './providers-list';

export function HealthBoard() {
  const providers = useQuery({ queryKey: ['providers', 'all'], queryFn: () => api.get<ProviderRow[]>('/v1/providers'), refetchInterval: 10_000 });
  if (providers.isPending) return <LoadingSkeleton />;
  if (providers.isError) return <ErrorState message={errorMessage(providers.error)} />;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {providers.data.map((p) => (
        <Link key={p.id} href={`/admin/providers/${p.id}`} className="group">
          <Card className="group-hover:border-primary/40 h-full shadow-none transition-colors">
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">{p.name}</CardTitle>
                <p className="text-muted-foreground font-mono text-xs">{p.code}</p>
              </div>
              <ProviderStatus p={p} />
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-3 text-sm">
              {(p.kind === 'BOTH' ? (['PAYIN', 'PAYOUT'] as const) : ([p.kind] as const)).map((k) => {
                const h = healthFor(p, k);
                return (
                  <div key={k} className="col-span-3 grid grid-cols-3 gap-3">
                    <div><p className="text-muted-foreground text-xs">{k} success</p><p className="tabular font-semibold">{pct(h?.success_rate)}</p></div>
                    <div><p className="text-muted-foreground text-xs">p95</p><p className="tabular font-semibold">{ms(h?.p95_latency_ms)}</p></div>
                    <div><p className="text-muted-foreground text-xs">Requests</p><p className="tabular font-semibold">{h?.requests ?? 0}</p></div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
