'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@pay2all/ui/components/ui/button';
import { loginFormSchema, totpCodeSchema } from '@pay2all/validation';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api/client';
import type { Me, SessionTokens } from '@/lib/api/types';
import { useAuthStore } from '@/lib/auth/store';
import { homePathFor, ME_QUERY_KEY } from '@/lib/auth/use-me';

const mfaFormSchema = z.object({ code: totpCodeSchema });

/** Only allow same-origin relative redirects (no open redirect via ?next=). */
function safeNext(next: string | null): string | null {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const credentials = useForm<z.input<typeof loginFormSchema>>({ resolver: zodResolver(loginFormSchema), defaultValues: { identifier: '', password: '' } });
  const mfa = useForm<z.input<typeof mfaFormSchema>>({ resolver: zodResolver(mfaFormSchema), defaultValues: { code: '' } });

  async function finish(tokens: SessionTokens) {
    setAccessToken(tokens.access_token!);
    if (tokens.status === 'MFA_ENROLLMENT_REQUIRED') {
      router.replace('/setup-mfa');
      return;
    }
    const me = await queryClient.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: () => api.get<Me>('/v1/auth/me') });
    router.replace(safeNext(params.get('next')) ?? homePathFor(me));
  }

  const onCredentials = credentials.handleSubmit(async (values) => {
    setError(null);
    try {
      const tokens = await api.post<SessionTokens>('/v1/auth/login', values, { auth: false });
      if (tokens.status === 'MFA_REQUIRED') setMfaToken(tokens.mfa_token!);
      else await finish(tokens);
    } catch (err) {
      setError(err);
    }
  });

  const onMfa = mfa.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      await finish(await api.post<SessionTokens>('/v1/auth/mfa/verify', { mfa_token: mfaToken, code }, { auth: false }));
    } catch (err) {
      setError(err);
      mfa.reset({ code: '' });
    }
  });

  if (mfaToken) {
    return (
      <AuthCard
        title="Two-factor verification"
        description="Enter the 6-digit code from your authenticator app."
        footer={<button type="button" className="text-primary font-medium hover:underline" onClick={() => { setMfaToken(null); setError(null); }}>Use a different account</button>}
      >
        <FormError error={error} />
        <form onSubmit={onMfa} className="space-y-5" noValidate>
          <FormField
            label="Authentication code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            className="text-center font-mono text-lg tracking-[0.5em]"
            error={mfa.formState.errors.code?.message}
            {...mfa.register('code')}
          />
          <Button type="submit" className="w-full" disabled={mfa.formState.isSubmitting}>
            {mfa.formState.isSubmitting ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify
          </Button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in" description="Welcome back. Sign in to your Pay2All account.">
      <FormError error={error} />
      <form onSubmit={onCredentials} className="space-y-5" noValidate>
        <FormField label="Email or mobile number" autoComplete="username" autoFocus error={credentials.formState.errors.identifier?.message} {...credentials.register('identifier')} />
        <div className="space-y-1.5">
          <FormField label="Password" type="password" autoComplete="current-password" error={credentials.formState.errors.password?.message} {...credentials.register('password')} />
          <div className="text-right">
            <Link href="/forgot-password" className="text-primary text-xs font-medium hover:underline">Forgot password?</Link>
          </div>
        </div>
        <Button type="submit" className="w-full" disabled={credentials.formState.isSubmitting}>
          {credentials.formState.isSubmitting && <Loader2 className="animate-spin" />} Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
