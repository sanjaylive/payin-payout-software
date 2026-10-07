'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { PageHeader } from '@/components/common/page-header';
import { LoginActivity } from '@/features/security/login-activity';
import { UsersTable } from '@/features/users-table';
import { useCan, useMe } from '@/lib/auth/use-me';

export default function TeamPage() {
  const { data: me } = useMe();
  const can = useCan();
  if (!me) return null;
  return (
    <>
      <PageHeader title="Team" description={`People with access to ${me.organization.name}, and their sign-in history.`} />
      <Tabs defaultValue="members">
        <TabsList><TabsTrigger value="members">Members</TabsTrigger>{can('user.read') && <TabsTrigger value="logins">Login activity</TabsTrigger>}</TabsList>
        <TabsContent value="members" className="mt-4"><UsersTable me={me} /></TabsContent>
        <TabsContent value="logins" className="mt-4"><LoginActivity /></TabsContent>
      </Tabs>
    </>
  );
}
