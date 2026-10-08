'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@pay2all/ui/components/ui/button';
import { loginFormSchema, recoveryCodeSchema, totpCodeSchema } from '@pay2all/validation';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, MapPin, ShieldCheck } from 'lucide-react';
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
import { useBrand } from '@/lib/brand/brand-provider';
import { passkeyFailure, passkeysSupported, signWithPasskey } from '@/lib/auth/passkey';
import { useLoginLocation } from '@/lib/auth/use-login-location';
import { homePathFor, ME_QUERY_KEY } from '@/lib/auth/use-me';

const mfaFormSchema = z.object({ code: totpCodeSchema });
const recoveryFormSchema = z.object({ recovery_code: recoveryCodeSchema });

/** Only allow same-origin relative redirects (no open redirect via ?next=). */
function safeNext(next: string | null): string | null {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

export function LoginForm() {
  const brand = useBrand();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [methods, setMethods] = useState<{ totp: boolean; passkey: boolean }>({ totp: true, passkey: false });
  const [useRecovery, setUseRecovery] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const location = useLoginLocation();

  const credentials = useForm<z.input<typeof loginFormSchema>>({ resolver: zodResolver(loginFormSchema), defaultValues: { identifier: '', password: '' } });
  const mfa = useForm<z.input<typeof mfaFormSchema>>({ resolver: zodResolver(mfaFormSchema), defaultValues: { code: '' } });
  const recovery = useForm<z.input<typeof recoveryFormSchema>>({ resolver: zodResolver(recoveryFormSchema), defaultValues: { recovery_code: '' } });

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
      const loc = location.current();
      const tokens = await api.post<SessionTokens>('/v1/auth/login', { ...values, ...(loc ? { location: loc } : {}) }, { auth: false });
      if (tokens.status === 'MFA_REQUIRED') {
        setMethods(tokens.mfa_methods ?? { totp: true, passkey: false });
        setUseRecovery(false);
        setMfaToken(tokens.mfa_token!);
      } else await finish(tokens);
    } catch (err) {
      setError(err);
    }
  });

  const onMfa = mfa.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      const loc = location.current();
      await finish(await api.post<SessionTokens>('/v1/auth/mfa/verify', { mfa_token: mfaToken, code, ...(loc ? { location: loc } : {}) }, { auth: false }));
    } catch (err) {
      setError(err);
      mfa.reset({ code: '' });
    }
  });

  const verify = async (proof: Record<string, unknown>) => {
    const loc = location.current();
    await finish(await api.post<SessionTokens>('/v1/auth/mfa/verify', { mfa_token: mfaToken, ...proof, ...(loc ? { location: loc } : {}) }, { auth: false }));
  };

  const onRecovery = recovery.handleSubmit(async ({ recovery_code }) => {
    setError(null);
    try {
      await verify({ recovery_code });
    } catch (err) {
      setError(err);
      recovery.reset({ recovery_code: '' });
    }
  });

  async function onPasskey() {
    setError(null);
    setPasskeyBusy(true);
    try {
      const passkey = await signWithPasskey('/v1/auth/mfa/passkey/options', { mfa_token: mfaToken }, false);
      await verify({ passkey });
    } catch (err) {
      setError(passkeyFailure(err));
    } finally {
      setPasskeyBusy(false);
    }
  }

  if (mfaToken) {
    const showPasskey = methods.passkey && passkeysSupported() && !useRecovery;
    const showCode = methods.totp && !useRecovery;
    return (
      <AuthCard
        title="Two-factor verification"
        description={
          useRecovery
            ? 'Enter one of the recovery codes you saved when you set up two-factor.'
            : showPasskey
              ? 'Confirm with the passkey on this device or your security key.'
              : 'Enter the 6-digit code from your authenticator app.'
        }
        footer={
          <div className="flex flex-col items-center gap-2">
            <button type="button" className="text-primary font-medium hover:underline" onClick={() => { setUseRecovery(!useRecovery); setError(null); }}>
              {useRecovery ? 'Back to two-factor' : 'Use a recovery code'}
            </button>
            <button type="button" className="text-muted-foreground hover:underline" onClick={() => { setMfaToken(null); setError(null); }}>Use a different account</button>
          </div>
        }
      >
        <FormError error={error} />
        {showPasskey && (
          <Button type="button" size="lg" className="mb-4 w-full" onClick={() => void onPasskey()} disabled={passkeyBusy}>
            {passkeyBusy ? <Loader2 className="animate-spin" /> : <KeyRound />} Sign in with passkey
          </Button>
        )}
        {showPasskey && showCode && (
          <div className="text-muted-foreground mb-4 flex items-center gap-3 text-xs">
            <span className="bg-border h-px flex-1" /> or use your authenticator app <span className="bg-border h-px flex-1" />
          </div>
        )}
        {useRecovery && (
          <form onSubmit={onRecovery} className="space-y-5" noValidate>
            <FormField label="Recovery code" autoComplete="off" placeholder="ABCDE-FGH23" autoFocus className="text-center font-mono uppercase tracking-widest" error={recovery.formState.errors.recovery_code?.message} {...recovery.register('recovery_code')} />
            <Button type="submit" className="w-full" disabled={recovery.formState.isSubmitting}>
              {recovery.formState.isSubmitting ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify
            </Button>
          </form>
        )}
        {showCode && <form onSubmit={onMfa} className="space-y-5" noValidate>
          <FormField
            label="Authentication code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus={!showPasskey}
            className="text-center font-mono text-lg tracking-[0.5em]"
            error={mfa.formState.errors.code?.message}
            {...mfa.register('code')}
          />
          <Button type="submit" variant={showPasskey ? 'outline' : 'default'} className="w-full" disabled={mfa.formState.isSubmitting}>
            {mfa.formState.isSubmitting ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify
          </Button>
        </form>}
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in" description={`Welcome back. Sign in to your ${brand.short_name} account.`}>
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
        <p className="text-muted-foreground flex items-start gap-1.5 text-[11px] leading-4">
          <MapPin className="mt-px size-3 shrink-0" />
          {location.state === 'granted'
            ? 'Your sign-in location will be recorded in your account’s login history.'
            : 'If you allow location access, we record where you signed in from, to help protect your account. It’s optional.'}
        </p>
      </form>
    </AuthCard>
  );
}
