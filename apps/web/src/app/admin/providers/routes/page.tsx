'use client';

import { PageHeader } from '@/components/common/page-header';
import { RoutesManager } from '@/features/providers/routes-manager';

export default function RoutesPage() {
  return (
    <>
      <PageHeader title="Routing rules" description="PRIMARY → SECONDARY → FALLBACK. A transaction only fails over when the previous provider provably didn't process it." />
      <RoutesManager />
    </>
  );
}
