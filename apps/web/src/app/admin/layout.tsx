'use client';

import type { ReactNode } from 'react';
import { AuthGate } from '@/components/auth/auth-gate';
import { AppShell } from '@/components/shell/app-shell';
import { ADMIN_NAV } from '@/components/shell/nav-config';

/** Separate super-admin layout — platform staff only. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate allow={['PLATFORM']}>
      {(me) => (
        <AppShell me={me} nav={ADMIN_NAV} securityHref="/admin/settings/security">
          {children}
        </AppShell>
      )}
    </AuthGate>
  );
}
