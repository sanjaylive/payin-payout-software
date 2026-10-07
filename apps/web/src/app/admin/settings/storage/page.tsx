'use client';

import { PageHeader } from '@/components/common/page-header';
import { StorageSettings } from '@/features/storage/storage-settings';

export default function FileStoragePage() {
  return (
    <>
      <PageHeader
        level={2}
        title="File storage"
        description="Where KYC documents, reconciliation files and report exports are kept. Pay2All encrypts every file before it leaves the server, whichever storage you choose."
      />
      <StorageSettings />
    </>
  );
}
