'use client';

import { PageHeader } from '@/components/common/page-header';
import { BrandSettings } from '@/features/brand/brand-settings';

export default function BrandSettingsPage() {
  return (
    <>
      <PageHeader level={2} title="Brand" description="Logo, name, colour and contact details — everywhere your users see them." />
      <BrandSettings />
    </>
  );
}
