'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { AuthGate } from '@/components/auth/auth-gate';
import { PasskeyEnrollment } from '@/components/auth/passkey-enrollment';
import { TotpEnrollment } from '@/components/auth/totp-enrollment';
import { RecoveryCodesDialog } from '@/features/security-settings';
import { api } from '@/lib/api/client';
import type { Me } from '@/lib/api/types';
import { homePathFor, ME_QUERY_KEY } from '@/lib/auth/use-me';

export default function SetupMfaPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [codes, setCodes] = useState<string[] | null>(null);
  async function goHome() {
    const fresh = await queryClient.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: () => api.get<Me>('/v1/auth/me'), staleTime: 0 });
    router.replace(homePathFor(fresh));
  }
  return (
    <AuthGate allowRestricted>
      {(me) => (
        <AuthCard
          title="Secure your account"
          description={`Your role requires two-factor authentication. Set it up to continue as ${me.user.email}.`}
        >
          <Tabs defaultValue="passkey">
            <TabsList className="mb-5 grid w-full grid-cols-2">
              <TabsTrigger value="passkey">Passkey (recommended)</TabsTrigger>
              <TabsTrigger value="app">Authenticator app</TabsTrigger>
            </TabsList>
            <TabsContent value="passkey">
              <PasskeyEnrollment onAdded={(r) => (r.recovery_codes ? setCodes(r.recovery_codes) : void goHome())} />
            </TabsContent>
            <TabsContent value="app">
              <TotpEnrollment onEnabled={(c) => (c?.length ? setCodes(c) : void goHome())} />
            </TabsContent>
          </Tabs>
          <RecoveryCodesDialog codes={codes} onClose={() => void goHome()} />
        </AuthCard>
      )}
    </AuthGate>
  );
}
