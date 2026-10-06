import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResetForm } from './reset-form';

export const metadata: Metadata = { title: 'Set password' };

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
