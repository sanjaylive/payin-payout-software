'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Alert, AlertDescription } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, Save } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/form-error';
import { MerchantCombobox } from '@/components/common/merchant-combobox';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import type { AgentProgramSettings } from '../api';

const KEY = ['admin', 'agent-settings'];

/** Admin → Agents → Settings: the platform merchant whose payment links collect plan fees. */
export function AdminAgentSettings() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<AgentProgramSettings>('/v1/admin/agent-settings') });
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-48 rounded-xl" />;
  return <SettingsForm key={q.data.billing_merchant_id ?? 'none'} settings={q.data} />;
}

function SettingsForm({ settings }: { settings: AgentProgramSettings }) {
  const can = useCan();
  const qc = useQueryClient();
  const manage = can('agent.admin.manage');
  const [merchant, setMerchant] = useState<string | null>(settings.billing_merchant_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(KEY, await api.put<AgentProgramSettings>('/v1/admin/agent-settings', { billing_merchant_id: merchant }));
      toast.success('Billing merchant saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-card max-w-2xl space-y-4 rounded-xl border p-5">
      <div>
        <h2 className="text-base font-semibold">Billing merchant</h2>
        <p className="text-muted-foreground text-sm">Agents pay for plans through payment links on this merchant, with the platform&apos;s gateways. Choose one of the platform&apos;s own approved merchants with collections on.</p>
      </div>
      {settings.billing_merchant_id ? (
        settings.billing_ready ? (
          <Alert className="border-success/40 bg-success-muted">
            <CheckCircle2 className="text-success" />
            <AlertDescription className="text-foreground">Online plan payments are on, collected by {settings.billing_merchant_name ?? settings.billing_merchant_id}.</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{settings.billing_merchant_name ?? 'The chosen merchant'} cannot collect right now (not approved or collections off). Agents see &ldquo;Contact support to upgrade&rdquo;.</AlertDescription>
          </Alert>
        )
      ) : (
        <Alert>
          <AlertTriangle />
          <AlertDescription>No billing merchant yet: agents can&apos;t pay online. You can still grant plans from an agent&apos;s page.</AlertDescription>
        </Alert>
      )}
      <FormError error={error} />
      <div className="space-y-1.5">
        <Label>Merchant</Label>
        <MerchantCombobox value={merchant} onChange={(m) => setMerchant(m?.id ?? null)} status="APPROVED" anyLabel="None (no online payment)" disabled={!manage} ariaLabel="Billing merchant" />
      </div>
      {manage && (
        <Button disabled={busy || merchant === settings.billing_merchant_id} onClick={() => void save()}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />} Save
        </Button>
      )}
    </section>
  );
}
