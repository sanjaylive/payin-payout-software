'use client';

import type { ReactNode } from 'react';
import { AuthGate } from '@/components/auth/auth-gate';
import { AppShell } from '@/components/shell/app-shell';
import { MERCHANT_NAV, PARTNER_NAV, RESELLER_NAV } from '@/components/shell/nav-config';

/** Merchant, reseller and API-partner portal. Platform staff are routed to /admin. */
export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate allow={['MERCHANT', 'RESELLER', 'API_PARTNER']}>
      {(me) => (
        <AppShell me={me} nav={me.organization.type === 'RESELLER' ? RESELLER_NAV : me.organization.type === 'API_PARTNER' ? PARTNER_NAV : MERCHANT_NAV} securityHref="/settings/security">
          {children}
        </AppShell>
      )}
    </AuthGate>
  );
}
