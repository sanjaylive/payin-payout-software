'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { AuthGate } from '@/components/auth/auth-gate';
import { TotpEnrollment } from '@/components/auth/totp-enrollment';
import { api } from '@/lib/api/client';
import type { Me } from '@/lib/api/types';
import { homePathFor, ME_QUERY_KEY } from '@/lib/auth/use-me';

export default function SetupMfaPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return (
    <AuthGate allowRestricted>
      {(me) => (
        <AuthCard
          title="Secure your account"
          description={`Your role requires two-factor authentication. Set it up to continue as ${me.user.email}.`}
        >
          <TotpEnrollment
            onEnabled={async () => {
              const fresh = await queryClient.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: () => api.get<Me>('/v1/auth/me') });
              router.replace(homePathFor(fresh));
            }}
          />
        </AuthCard>
      )}
    </AuthGate>
  );
}
