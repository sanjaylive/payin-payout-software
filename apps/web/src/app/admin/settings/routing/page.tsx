'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/common/page-header';
import { RoutesManager } from '@/features/providers/routes-manager';
import { ADAPTER_LABELS, SERVICE_LABELS } from '@/features/vendors/labels';
import { api } from '@/lib/api/client';

interface ChannelRouting {
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  services: { service_id: string; name: string; vendor: string; adapter: string; priority: number }[];
}

export default function RoutingPage() {
  const messaging = useQuery({ queryKey: ['messaging-routing'], queryFn: () => api.get<ChannelRouting[]>('/v1/messaging-routing') });
  return (
    <>
      <PageHeader title="Routing" description="Which vendor handles each transaction or message, and what happens when it can’t." />
      <div className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Payments</h2>
          <p className="text-muted-foreground text-sm">PRIMARY → SECONDARY → FALLBACK. A transaction only fails over when the previous vendor provably didn’t process it.</p>
          <RoutesManager />
        </section>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Messaging</CardTitle>
            <CardDescription>Active services per channel, in the order they are tried. Change priority or switch services on and off on each vendor.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            {(messaging.data ?? []).map((r) => (
              <div key={r.channel} className="rounded-lg border p-3">
                <p className="mb-2 text-sm font-medium">{SERVICE_LABELS[r.channel]}</p>
                {r.services.length ? (
                  <ol className="space-y-1 text-sm">
                    {r.services.map((s, i) => <li key={s.service_id}><span className="text-muted-foreground tabular mr-2">{i + 1}.</span>{s.name} <span className="text-muted-foreground text-xs">({s.vendor} · {ADAPTER_LABELS[s.adapter] ?? s.adapter})</span></li>)}
                  </ol>
                ) : (
                  <p className="text-muted-foreground text-sm">{r.channel === 'EMAIL' ? 'None — using the server’s SMTP setting.' : 'None active — messages wait until one is.'}</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
