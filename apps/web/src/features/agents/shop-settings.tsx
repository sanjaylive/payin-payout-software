'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ConfirmDialog } from '@pay2all/ui/components/confirm-dialog';
import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { agentProfileUpdateSchema } from '@pay2all/validation';
import { useQueryClient } from '@tanstack/react-query';
import { ImageUp, Loader2, Save, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { api, ApiError, apiUpload } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { AgentProfile } from './api';
import { PlanTag } from './bits';
import { AGENT_KEY, PROFILE_KEY, useAgentProfile } from './hooks';
import { useAuthImage } from './my-qr';

type Values = z.input<typeof agentProfileUpdateSchema>;

/** /agent/settings: shop details printed on receipts, UPI id for the QR, QR image and logo. */
export function ShopSettings() {
  const profile = useAgentProfile();
  if (profile.isError) return <ErrorState message={errorMessage(profile.error)} onRetry={() => void profile.refetch()} />;
  return (
    <>
      <PageHeader title="Shop settings" description="What your receipts and QR show." />
      {profile.data ? (
        <div className="space-y-5">
          <ProfileForm profile={profile.data} />
          <div className="grid gap-5 md:grid-cols-2">
            <ImageCard profile={profile.data} kind="qr" />
            <ImageCard profile={profile.data} kind="logo" />
          </div>
          <section className="bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
            <div>
              <h2 className="text-base font-semibold">Password and two-factor sign-in</h2>
              <p className="text-muted-foreground text-sm">Change your password, turn on two-factor, see signed-in devices.</p>
            </div>
            <Button variant="outline" asChild>
              <Link href="/agent/security">
                <ShieldCheck /> Security
              </Link>
            </Button>
          </section>
        </div>
      ) : (
        <Skeleton className="h-96 rounded-xl" />
      )}
    </>
  );
}

function ProfileForm({ profile }: { profile: AgentProfile }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const branded = profile.plan.branded_receipts;
  const form = useForm<Values, unknown, z.output<typeof agentProfileUpdateSchema>>({
    resolver: zodResolver(agentProfileUpdateSchema),
    defaultValues: {
      shop_name: profile.shop_name,
      owner_name: profile.owner_name,
      address_line: profile.address_line ?? '',
      city: profile.city ?? '',
      state: profile.state ?? '',
      pincode: profile.pincode ?? '',
      upi_vpa: profile.upi_vpa ?? '',
      upi_payee_name: profile.upi_payee_name ?? '',
      receipt_footer: profile.receipt_footer ?? '',
    },
  });
  const e = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const saved = await api.patch<AgentProfile>('/v1/agent/profile', v);
      qc.setQueryData(PROFILE_KEY, saved);
      await qc.invalidateQueries({ queryKey: AGENT_KEY });
      form.reset(form.getValues());
      toast.success('Shop details saved');
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) for (const d of err.details) form.setError(d.path as keyof Values, { message: d.message });
      setError(err);
    }
  });
  return (
    <form onSubmit={(ev) => void submit(ev)} className="bg-card space-y-5 rounded-xl border p-4 sm:p-5" noValidate>
      <FormError error={error} />
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold">Shop</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="s-shop" label="Shop name" error={e.shop_name?.message} {...form.register('shop_name')} />
          <FormField id="s-owner" label="Owner name" error={e.owner_name?.message} {...form.register('owner_name')} />
          <div className="sm:col-span-2">
            <FormField id="s-address" label="Address" error={e.address_line?.message} {...form.register('address_line')} />
          </div>
          <FormField id="s-city" label="City" error={e.city?.message} {...form.register('city')} />
          <div className="grid grid-cols-2 gap-4">
            <FormField id="s-state" label="State" error={e.state?.message} {...form.register('state')} />
            <FormField id="s-pin" label="PIN code" inputMode="numeric" maxLength={6} error={e.pincode?.message} {...form.register('pincode')} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Contact on receipts: {profile.mobile} · {profile.email}
        </p>
      </fieldset>
      <fieldset className="space-y-4 border-t pt-4">
        <legend className="sr-only">UPI</legend>
        <h3 className="text-base font-semibold">UPI for the payment QR</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="s-vpa" label="UPI id" placeholder="shopname@okaxis" autoComplete="off" error={e.upi_vpa?.message} hint="From your bank or UPI app" {...form.register('upi_vpa')} />
          <FormField id="s-payee" label="Payee name" error={e.upi_payee_name?.message} hint="Shown in the customer’s UPI app" {...form.register('upi_payee_name')} />
        </div>
      </fieldset>
      <fieldset className="space-y-2 border-t pt-4">
        <legend className="sr-only">Receipt footer</legend>
        <h3 className="flex items-center gap-2 text-base font-semibold">
          Receipt footer {!branded && <PlanTag>Starter / Business</PlanTag>}
        </h3>
        <FormField
          id="s-footer"
          label="Footer text"
          maxLength={200}
          placeholder="Thank you! Timings 9 am – 8 pm"
          error={e.receipt_footer?.message}
          hint={branded ? 'Printed at the bottom of every receipt.' : 'Saved now; appears on receipts on the Starter and Business plans.'}
          {...form.register('receipt_footer')}
        />
      </fieldset>
      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
          {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : <Save />} Save
        </Button>
      </div>
    </form>
  );
}

function ImageCard({ profile, kind }: { profile: AgentProfile; kind: 'qr' | 'logo' }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const has = kind === 'qr' ? profile.has_qr_image : profile.has_logo;
  const src = useAuthImage(`/v1/agent/profile/${kind}`, has);
  const title = kind === 'qr' ? 'Bank QR image' : 'Shop logo';

  async function upload(file: File) {
    if (file.size > 2 * 1024 * 1024) return toast.error('The image can be at most 2 MB');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const saved = await apiUpload<AgentProfile>(`/v1/agent/profile/${kind}`, form);
      qc.setQueryData(PROFILE_KEY, saved);
      await qc.invalidateQueries({ queryKey: AGENT_KEY });
      toast.success(`${title} uploaded`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const saved = await api.delete<AgentProfile>(`/v1/agent/profile/${kind}`);
      qc.setQueryData(PROFILE_KEY, saved);
      await qc.invalidateQueries({ queryKey: AGENT_KEY });
      toast.success(`${title} removed`);
      setConfirm(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-card flex flex-col gap-3 rounded-xl border p-4 sm:p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {title} {kind === 'logo' && !profile.plan.branded_receipts && <PlanTag>Starter / Business</PlanTag>}
        </h2>
        <p className="text-muted-foreground text-sm">
          {kind === 'qr' ? 'The QR your bank gave you. Shown as-is on the My QR page.' : 'Printed on receipts on the Starter and Business plans.'} PNG, JPEG or WebP, up to 2 MB.
        </p>
      </div>
      <div className="bg-muted/40 grid min-h-40 place-items-center rounded-lg border border-dashed p-3">
        {has ? (
          src ? (
            // eslint-disable-next-line @next/next/no-img-element -- private image from the API as a data URL
            <img src={src} alt={title} className="max-h-48 w-auto rounded bg-white object-contain" />
          ) : (
            <Skeleton className="size-36" />
          )
        ) : (
          <p className="text-muted-foreground text-sm">Nothing uploaded</p>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        aria-label={`Choose ${title.toLowerCase()}`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="h-11" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Loader2 className="animate-spin" /> : <ImageUp />} {has ? 'Replace' : 'Upload'}
        </Button>
        {has && (
          <Button variant="ghost" className="text-muted-foreground hover:text-destructive h-11" disabled={busy} onClick={() => setConfirm(true)}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove the ${title.toLowerCase()}?`} description="You can upload another one any time." confirmLabel="Remove" destructive pending={busy} onConfirm={() => void remove()} />
    </section>
  );
}
