'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import type { OrganizationType } from '@pay2all/types';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { refreshSession } from '@/lib/api/client';
import type { Me } from '@/lib/api/types';
import { useAuthStore } from '@/lib/auth/store';
import { homePathFor, useMe } from '@/lib/auth/use-me';
import { FullPageSpinner } from '../common/full-page-spinner';

/**
 * Client-side session gate. The API is the real enforcement point — this only decides what to render:
 * restore the session from the refresh cookie, send restricted sessions to MFA enrollment, and keep
 * users inside the portal matching their organization type.
 */
export function AuthGate({
  allow,
  allowRestricted = false,
  children,
}: {
  allow?: OrganizationType[];
  allowRestricted?: boolean;
  children: (me: Me) => ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const token = useAuthStore((s) => s.accessToken);
  const me = useMe();

  useEffect(() => {
    if (token) return;
    let cancelled = false;
    void refreshSession().then((ok) => {
      // Success needs no handling here: refresh stores the token, which re-renders this gate. (Flipping
      // a local "restoring" flag here used to hang on the spinner: storing the token re-runs this
      // effect and cancels this callback before it runs.)
      if (!ok && !cancelled) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [token, router, pathname]);

  const data = me.data;
  const wrongPortal = data && ((data.session.restricted && !allowRestricted) || (allow && !allow.includes(data.organization.type)));
  useEffect(() => {
    if (data && wrongPortal) router.replace(homePathFor(data));
  }, [data, wrongPortal, router]);

  if (!token || me.isPending || wrongPortal) return <FullPageSpinner />;
  if (me.isError || !data) {
    return <ErrorState className="min-h-dvh" message="We couldn't load your account." onRetry={() => void me.refetch()} />;
  }
  return <>{children(data)}</>;
}
