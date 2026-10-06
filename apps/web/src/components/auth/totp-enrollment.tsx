'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@pay2all/ui/components/ui/button';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { totpCodeSchema } from '@pay2all/validation';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api } from '@/lib/api/client';
import { useAuthStore } from '@/lib/auth/store';
import { FormField } from '../common/form-field';
import { FormError } from './form-error';

const schema = z.object({ code: totpCodeSchema });

/** TOTP enrollment: QR + manual secret (shown once), then code confirmation. */
export function TotpEnrollment({ onEnabled }: { onEnabled: () => void }) {
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const [error, setError] = useState<unknown>(null);
  const setup = useMutation({ mutationFn: () => api.post<{ secret: string; qr_data_url: string }>('/v1/auth/mfa/totp/setup') });
  const form = useForm<z.input<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { code: '' } });

  const { mutate } = setup;
  useEffect(() => mutate(), [mutate]);

  const onSubmit = form.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      const res = await api.post<{ access_token: string }>('/v1/auth/mfa/totp/enable', { code });
      setAccessToken(res.access_token);
      onEnabled();
    } catch (err) {
      setError(err);
    }
  });

  return (
    <div className="space-y-6">
      <FormError error={error ?? setup.error} />
      <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
        <li>Open Google Authenticator, Microsoft Authenticator, 1Password or a similar app.</li>
        <li>Scan the QR code (or enter the key manually).</li>
        <li>Enter the 6-digit code shown in the app.</li>
      </ol>
      <div className="flex flex-col items-center gap-3 rounded-lg border p-4">
        {setup.data ? (
          // eslint-disable-next-line @next/next/no-img-element -- data: URL generated server-side
          <img src={setup.data.qr_data_url} alt="Authenticator QR code" className="size-44 rounded bg-white p-1" />
        ) : (
          <Skeleton className="size-44" />
        )}
        {setup.data && (
          <p className="text-muted-foreground text-center text-xs">
            Manual key: <span className="text-foreground font-mono break-all select-all">{setup.data.secret}</span>
          </p>
        )}
      </div>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormField label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="font-mono tracking-[0.3em]" error={form.formState.errors.code?.message} {...form.register('code')} />
        <Button type="submit" className="w-full" disabled={!setup.data || form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="animate-spin" />} Enable two-factor authentication
        </Button>
      </form>
    </div>
  );
}
