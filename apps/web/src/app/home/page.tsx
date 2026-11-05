'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AuthGate } from '@/components/auth/auth-gate';
import { FullPageSpinner } from '@/components/common/full-page-spinner';
import type { Me } from '@/lib/api/types';
import { homePathFor } from '@/lib/auth/use-me';

function Redirect({ me }: { me: Me }) {
  const router = useRouter();
  useEffect(() => router.replace(homePathFor(me)), [me, router]);
  return <FullPageSpinner />;
}

/** Signed-in entry point: sends each user to their own dashboard ("/" is the public landing page). */
export default function Home() {
  return <AuthGate allowRestricted>{(me) => <Redirect me={me} />}</AuthGate>;
}
