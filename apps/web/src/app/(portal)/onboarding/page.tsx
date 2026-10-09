'use client';

import { Suspense } from 'react';
import { OnboardingWizard } from '@/features/onboarding/onboarding-wizard';

export default function OnboardingPage() {
  return (
    <Suspense>
      <OnboardingWizard />
    </Suspense>
  );
}
