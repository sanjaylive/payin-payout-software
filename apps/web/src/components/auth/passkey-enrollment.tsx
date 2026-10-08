'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Fingerprint, KeyRound, Loader2, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { defaultPasskeyName, passkeyFailure, passkeysSupported, type PasskeyRegistered, registerPasskey } from '@/lib/auth/passkey';
import { useAuthStore } from '@/lib/auth/store';
import { FormField } from '../common/form-field';
import { FormError } from './form-error';

/** Add a passkey: the device's fingerprint/face/PIN unlock, or a USB/NFC security key. */
export function PasskeyEnrollment({ onAdded }: { onAdded: (result: PasskeyRegistered) => void }) {
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const [name, setName] = useState(defaultPasskeyName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!passkeysSupported()) {
    return <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">This browser doesn&apos;t support passkeys. Use the authenticator app option, or open this page in a current version of Chrome, Safari, Edge or Firefox.</p>;
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const result = await registerPasskey(name.trim() || 'Passkey');
      if (result.access_token) setAccessToken(result.access_token);
      onAdded(result);
    } catch (e) {
      setError(passkeyFailure(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <FormError error={error} />
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        {[
          { icon: Fingerprint, label: 'Fingerprint or face' },
          { icon: Smartphone, label: 'Your phone' },
          { icon: KeyRound, label: 'Security key' },
        ].map(({ icon: Icon, label }) => (
          <div key={label} className="bg-muted/50 text-muted-foreground flex flex-col items-center gap-1.5 rounded-lg p-3">
            <Icon className="text-primary size-5" />
            {label}
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-sm">Passkeys only work on this website, so a fake sign-in page can&apos;t steal them. Nothing secret leaves your device.</p>
      <FormField name="passkey-name" label="Name this passkey" hint="So you can tell your devices apart" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      <Button className="w-full" onClick={() => void add()} disabled={busy || !name.trim()}>
        {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Create passkey
      </Button>
    </div>
  );
}
