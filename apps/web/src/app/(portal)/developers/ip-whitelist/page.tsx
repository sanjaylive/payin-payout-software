'use client';

import { PageHeader } from '@/components/common/page-header';
import { IpAllowlist } from '@/features/developers/ip-allowlist';

export default function IpWhitelistPage() {
  return (
    <>
      <PageHeader title="IP allowlist" description="Accept API calls only from your servers' public addresses." />
      <IpAllowlist />
    </>
  );
}
