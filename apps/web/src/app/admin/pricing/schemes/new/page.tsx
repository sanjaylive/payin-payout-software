'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SchemeEditor } from '@/features/schemes/scheme-editor';

function NewScheme() {
  const copy = useSearchParams().get('copy');
  return <SchemeEditor copyFrom={copy && /^sch_[0-9A-Z]{26}$/.test(copy) ? copy : undefined} />;
}

export default function NewSchemePage() {
  return (
    <Suspense>
      <NewScheme />
    </Suspense>
  );
}
