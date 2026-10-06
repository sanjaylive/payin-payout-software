'use client';

import { PageHeader } from '@/components/common/page-header';
import { UsersTable } from '@/features/users-table';
import { useMe } from '@/lib/auth/use-me';

export default function TeamPage() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <>
      <PageHeader title="Team" description={`People with access to ${me.organization.name}.`} />
      <UsersTable me={me} />
    </>
  );
}
