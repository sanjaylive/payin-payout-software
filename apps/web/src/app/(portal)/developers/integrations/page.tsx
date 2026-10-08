'use client';

import { PageHeader } from '@/components/common/page-header';
import { Integrations } from '@/features/developers/integrations';

export default function IntegrationsPage() {
  return (
    <>
      <PageHeader title="Integrations" description="Popup checkout for your website, plugins for WooCommerce and OpenCart, and the PHP SDK." />
      <Integrations />
    </>
  );
}
