'use client';

import { SecuritySettings } from '@/features/security-settings';
import { useMe } from '@/lib/auth/use-me';

export default function AdminSecurityPage() {
  const { data: me } = useMe();
  return me ? <SecuritySettings me={me} embedded /> : null;
}
