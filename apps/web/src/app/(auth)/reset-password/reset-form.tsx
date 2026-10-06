'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@pay2all/ui/components/ui/button';
import { passwordSchema } from '@pay2all/validation';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api, ApiError } from '@/lib/api/client';

const schema = z
  .object({ new_password: passwordSchema, confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

export function ResetForm() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.input<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { new_password: '', confirm: '' } });

  const onSubmit = form.handleSubmit(async ({ new_password }) => {
    setError(null);
    try {
      await api.post('/v1/auth/password/reset', { token, new_password }, { auth: false });
      toast.success('Password set. You can now sign in.');
      router.replace('/login');
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) {
        form.setError('new_password', { message: err.details.map((d) => d.message).join('. ') });
      } else setError(err);
    }
  });

  if (!token) {
    return (
      <AuthCard title="Link invalid" description="This password link is missing its token." footer={<Link href="/forgot-password" className="text-primary font-medium hover:underline">Request a new link</Link>}>
        {null}
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" description="Use at least 12 characters. A passphrase works well.">
      <FormError error={error} />
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <FormField label="New password" type="password" autoComplete="new-password" autoFocus error={form.formState.errors.new_password?.message} {...form.register('new_password')} />
        <FormField label="Confirm password" type="password" autoComplete="new-password" error={form.formState.errors.confirm?.message} {...form.register('confirm')} />
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="animate-spin" />} Set password
        </Button>
      </form>
    </AuthCard>
  );
}
