import { Alert, AlertDescription } from '@pay2all/ui/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { ApiError } from '@/lib/api/client';

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertCircle />
      <AlertDescription>
        {message}
        {error instanceof ApiError && error.code === 'RATE_LIMITED' && ' Please wait a few minutes.'}
      </AlertDescription>
    </Alert>
  );
}
