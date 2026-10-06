'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { PageHeader } from '@/components/common/page-header';
import { RolesList } from '@/features/roles-list';
import { UsersTable } from '@/features/users-table';
import { useMe } from '@/lib/auth/use-me';

export default function AdminUsersPage() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <>
      <PageHeader title="Users & Roles" description="Every user across platform and tenants, and what each role can do." />
      <Tabs defaultValue="users">
        <TabsList className="mb-4">
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="roles">Roles & permissions</TabsTrigger>
        </TabsList>
        <TabsContent value="users"><UsersTable me={me} platformView /></TabsContent>
        <TabsContent value="roles"><RolesList /></TabsContent>
      </Tabs>
    </>
  );
}
