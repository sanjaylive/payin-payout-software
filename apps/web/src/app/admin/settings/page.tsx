'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useMe } from '@/lib/auth/use-me';
import { SETTINGS_TABS } from './tabs';

/** /admin/settings opens the first tab this user may see. */
export default function SettingsIndex() {
  const router = useRouter();
  const { data: me } = useMe();
  useEffect(() => {
    if (!me) return;
    const first = SETTINGS_TABS.find((t) => !t.permission || me.permissions.includes(t.permission));
    router.replace(first?.href ?? '/admin/settings/security');
  }, [me, router]);
  return <Loader2 className="text-muted-foreground mx-auto mt-12 size-5 animate-spin" aria-label="Loading" />;
}
