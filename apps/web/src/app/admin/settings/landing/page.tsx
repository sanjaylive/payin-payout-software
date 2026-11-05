'use client';

import { PageHeader } from '@/components/common/page-header';
import { LandingSettings } from '@/features/landing/landing-settings';

export default function LandingSettingsPage() {
  return (
    <>
      <PageHeader level={2} title="Landing Page" description="Choose the public page visitors see at your home URL — the Payin/Payout gateway or the Merchant (CSP) payment record." />
      <LandingSettings />
    </>
  );
}
