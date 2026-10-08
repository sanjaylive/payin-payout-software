'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import { passkeyFailure, passkeysSupported, signWithPasskey } from '@/lib/auth/passkey';
import { setStepUpHandler } from '@/lib/auth/step-up';
import { FormField } from '../common/form-field';
import { FormError } from './form-error';

interface Methods {
  totp: boolean;
  passkey: boolean;
  recovery_code: boolean;
  password: boolean;
  window_seconds: number;
}

/**
 * "Confirm it's you" for sensitive actions. Mounted once; the API client opens it when a request is
 * refused with STEP_UP_REQUIRED and retries the request after a successful confirmation.
 */
export function StepUpDialog() {
  const [open, setOpen] = useState(false);
  const [methods, setMethods] = useState<Methods | null>(null);
  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
  }, []);

  useEffect(() => {
    setStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setMethods(null);
          setMode('code');
          setValue('');
          setError(null);
          setOpen(true);
          api
            .get<Methods>('/v1/auth/step-up')
            .then(setMethods)
            .catch((e: unknown) => setError(e));
        }),
    );
    return () => setStepUpHandler(null);
  }, []);

  async function confirm(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/auth/step-up', body);
      finish(true);
    } catch (e) {
      setError(e);
      setValue('');
    } finally {
      setBusy(false);
    }
  }

  async function confirmWithPasskey() {
    setBusy(true);
    setError(null);
    try {
      const passkey = await signWithPasskey('/v1/auth/step-up/passkey/options');
      await api.post('/v1/auth/step-up', { passkey });
      finish(true);
    } catch (e) {
      setError(passkeyFailure(e));
    } finally {
      setBusy(false);
    }
  }

  const minutes = methods ? Math.round(methods.window_seconds / 60) : 5;
  const field =
    methods?.password ? 'password' : mode === 'recovery' || !methods?.totp ? (methods?.recovery_code ? 'recovery' : null) : 'code';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && finish(false)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="bg-primary/10 text-primary mb-1 flex size-10 items-center justify-center rounded-full">
            <ShieldCheck className="size-5" />
          </div>
          <DialogTitle>Confirm it&apos;s you</DialogTitle>
          <DialogDescription>This is a sensitive action. After you confirm, you won&apos;t be asked again for {minutes} minutes.</DialogDescription>
        </DialogHeader>
        <FormError error={error} />
        {!methods && !error ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : methods ? (
          <div className="space-y-4">
            {methods.passkey && passkeysSupported() && (
              <Button className="w-full" size="lg" onClick={() => void confirmWithPasskey()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Use passkey
              </Button>
            )}
            {methods.passkey && field && (
              <div className="text-muted-foreground flex items-center gap-3 text-xs">
                <span className="bg-border h-px flex-1" /> or <span className="bg-border h-px flex-1" />
              </div>
            )}
            {field && (
              <form
                className="space-y-3"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void confirm(field === 'password' ? { password: value } : field === 'recovery' ? { recovery_code: value.trim() } : { code: value.trim() });
                }}
              >
                {field === 'password' ? (
                  <FormField name="step-up-password" label="Your password" type="password" autoComplete="current-password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
                ) : field === 'recovery' ? (
                  <FormField name="step-up-recovery" label="Recovery code" autoComplete="off" placeholder="ABCDE-FGH23" className="font-mono uppercase" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
                ) : (
                  <FormField
                    name="step-up-code"
                    label="Authenticator code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus={!methods.passkey}
                    className="text-center font-mono text-lg tracking-[0.4em]"
                    value={value}
                    onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
                  />
                )}
                <Button type="submit" variant={methods.passkey ? 'outline' : 'default'} className="w-full" disabled={busy || !value || (field === 'code' && value.length !== 6)}>
                  {busy && <Loader2 className="animate-spin" />} Confirm
                </Button>
              </form>
            )}
            {methods.totp && methods.recovery_code && (
              <button type="button" className="text-primary w-full text-center text-xs font-medium hover:underline" onClick={() => { setMode(mode === 'code' ? 'recovery' : 'code'); setValue(''); }}>
                {mode === 'code' ? 'Use a recovery code instead' : 'Use your authenticator app'}
              </button>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
