'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { refreshSession } from '@/lib/api/client';
import { useAuthStore } from '@/lib/auth/store';

/** "Sign in" for visitors; "Open dashboard" once a session exists (checked quietly via the refresh cookie). */
export function NavAccount({ signupHref }: { signupHref: string }) {
  const hasToken = useAuthStore((s) => Boolean(s.accessToken));
  const [refreshed, setRefreshed] = useState(false);
  const signedIn = hasToken || refreshed;

  useEffect(() => {
    if (hasToken) return;
    let live = true;
    refreshSession()
      .then((ok) => live && setRefreshed(ok))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hasToken]);

  if (signedIn) {
    return (
      <Link href="/home" className="l-btn l-btn-primary l-btn-sm">
        Open dashboard <ArrowRight className="size-4" />
      </Link>
    );
  }
  return (
    <>
      <Link href="/login" className="l-link hidden text-sm font-medium sm:inline">
        Sign in
      </Link>
      <Link href={signupHref} className="l-btn l-btn-primary l-btn-sm">
        Get started <ArrowRight className="size-4" />
      </Link>
    </>
  );
}
