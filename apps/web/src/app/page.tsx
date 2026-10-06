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

export default function Home() {
  return <AuthGate allowRestricted>{(me) => <Redirect me={me} />}</AuthGate>;
}
