'use client';

import { PageHeader } from '@/components/common/page-header';
import { ResellerBranding } from '@/features/brand/reseller-branding';

export default function ResellerBrandingPage() {
  return (
    <>
      <PageHeader title="Branding" description="Your own name, colours, logo and domain for your team, your merchants and their customers." />
      <ResellerBranding />
    </>
  );
}
