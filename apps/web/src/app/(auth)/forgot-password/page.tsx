'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, AlertDescription } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { forgotPasswordFormSchema } from '@pay2all/validation';
import { Loader2, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api/client';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.input<typeof forgotPasswordFormSchema>>({ resolver: zodResolver(forgotPasswordFormSchema), defaultValues: { identifier: '' } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/v1/auth/password/forgot', values, { auth: false });
      setSent(true);
    } catch (err) {
      setError(err);
    }
  });

  return (
    <AuthCard
      title="Reset your password"
      description="We'll email you a secure link that expires in 30 minutes."
      footer={<Link href="/login" className="text-primary font-medium hover:underline">Back to sign in</Link>}
    >
      {sent ? (
        <Alert>
          <MailCheck />
          <AlertDescription>If an account exists for that email or mobile, a reset link is on its way.</AlertDescription>
        </Alert>
      ) : (
        <>
          <FormError error={error} />
          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            <FormField label="Email or mobile number" autoComplete="username" autoFocus error={form.formState.errors.identifier?.message} {...form.register('identifier')} />
            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />} Send reset link
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}
