'use client';

import { SecuritySettings } from '@/features/security-settings';
import { useMe } from '@/lib/auth/use-me';

export default function SecurityPage() {
  const { data: me } = useMe();
  return me ? <SecuritySettings me={me} /> : null;
}
