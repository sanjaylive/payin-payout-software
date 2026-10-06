'use client';

import { PageHeader } from '@/components/common/page-header';
import { AuditLogTable } from '@/features/audit-log-table';

export default function AdminAuditLogsPage() {
  return (
    <>
      <PageHeader title="Audit Logs" description="Append-only record of privileged actions, sign-ins and security events. Entries cannot be edited or deleted." />
      <AuditLogTable />
    </>
  );
}
