'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { ArrowRight, Loader2, Save } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api, ApiError } from '@/lib/api/client';
import type { MerchantApplication, MerchantProfile } from '@/lib/api/types';
import { ENTITY_LABELS } from './labels';
import { useInvalidateMerchant } from './use-merchant';

const TEXT_FIELDS = [
  'legal_name', 'display_name', 'pan', 'gstin', 'cin', 'llpin', 'website', 'app_url', 'business_category', 'mcc',
  'business_description', 'expected_monthly_volume', 'average_ticket_size', 'maximum_ticket_size', 'contact_name',
  'contact_email', 'contact_mobile',
] as const;
/** Optional identifiers that can be cleared (sent as null). */
const NULLABLE = new Set(['gstin', 'cin', 'llpin', 'website', 'app_url']);

type TextField = (typeof TEXT_FIELDS)[number];
type AddressForm = { line1: string; line2: string; city: string; state: string; pincode: string };
interface FormValues extends Record<TextField, string> {
  entity_type: string;
  settlement_preference: string;
  payin_required: boolean;
  payout_required: boolean;
  registered_address: AddressForm;
}

const emptyAddress: AddressForm = { line1: '', line2: '', city: '', state: '', pincode: '' };

function toForm(p: MerchantProfile): FormValues {
  const text = Object.fromEntries(TEXT_FIELDS.map((f) => [f, (p[f] as string | null) ?? ''])) as Record<TextField, string>;
  return {
    ...text,
    entity_type: p.entity_type ?? '',
    settlement_preference: p.settlement_preference ?? '',
    payin_required: p.payin_required,
    payout_required: p.payout_required,
    registered_address: { ...emptyAddress, ...(p.registered_address ?? {}), line2: p.registered_address?.line2 ?? '' },
  };
}

/** Only send what changed; blank optional identifiers clear to null. */
function toPayload(values: FormValues, original: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of TEXT_FIELDS) {
    const v = values[f].trim();
    if (v === original[f]) continue;
    if (v === '') {
      if (NULLABLE.has(f)) out[f] = null;
      continue;
    }
    out[f] = ['pan', 'gstin', 'cin', 'llpin'].includes(f) ? v.toUpperCase() : v;
  }
  for (const f of ['entity_type', 'settlement_preference'] as const) if (values[f] && values[f] !== original[f]) out[f] = values[f];
  for (const f of ['payin_required', 'payout_required'] as const) if (values[f] !== original[f]) out[f] = values[f];
  const a = values.registered_address;
  if (JSON.stringify(a) !== JSON.stringify(original.registered_address) && a.line1) {
    out.registered_address = { line1: a.line1, ...(a.line2 ? { line2: a.line2 } : {}), city: a.city, state: a.state, pincode: a.pincode };
  }
  return out;
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

export type ProfileSection = 'identity' | 'address' | 'business' | 'volumes' | 'contact';
const ALL_SECTIONS: ProfileSection[] = ['identity', 'address', 'business', 'volumes', 'contact'];

export function ProfileForm({
  app,
  readOnly,
  sections = ALL_SECTIONS,
  title = 'Business details',
  description = 'Save as you go — everything is checked again when you submit.',
  onSaved,
}: {
  app: MerchantApplication;
  readOnly: boolean;
  /** Which parts to show (the onboarding wizard splits the profile over two steps). */
  sections?: ProfileSection[];
  title?: string;
  description?: string;
  /** Wizard mode: called after a successful save (or when nothing changed) to move on. */
  onSaved?: () => void;
}) {
  const show = (s: ProfileSection) => sections.includes(s);
  const invalidate = useInvalidateMerchant(app.id);
  const original = toForm(app.profile);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<FormValues>({ defaultValues: original });
  const { register, control, formState } = form;
  const err = (path: string) => (formState.errors as Record<string, { message?: string } | undefined>)[path]?.message;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const payload = toPayload(values, original);
    if (!Object.keys(payload).length) {
      if (onSaved) onSaved();
      else toast.info('No changes to save');
      return;
    }
    try {
      await api.patch(`/v1/merchants/${app.id}/profile`, payload);
      toast.success('Business profile saved');
      await invalidate();
      form.reset(values);
      onSaved?.();
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) {
        for (const d of e.details) form.setError(d.path as keyof FormValues, { message: d.message });
        setError(new ApiError(e.status, e.code, 'Some fields need attention', e.requestId));
      } else setError(e);
    }
  });

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <FormError error={error} />
        <form onSubmit={onSubmit} noValidate>
          <fieldset disabled={readOnly} className="space-y-8">
            {show('identity') && <Section title="Identity">
              <FormField label="Legal name" error={err('legal_name')} {...register('legal_name')} />
              <FormField label="Display name" hint="Shown to your customers" error={err('display_name')} {...register('display_name')} />
              <div className="space-y-1.5">
                <Label htmlFor="entity_type">Entity type</Label>
                <Controller
                  control={control}
                  name="entity_type"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={readOnly}>
                      <SelectTrigger id="entity_type" className="w-full"><SelectValue placeholder="Select entity type" /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(ENTITY_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <FormField label="Business PAN" className="font-mono uppercase" maxLength={10} error={err('pan')} {...register('pan')} />
              <FormField label="GSTIN (optional)" className="font-mono uppercase" maxLength={15} error={err('gstin')} {...register('gstin')} />
              <FormField label="CIN (companies)" className="font-mono uppercase" maxLength={21} error={err('cin')} {...register('cin')} />
              <FormField label="LLPIN (LLPs)" className="font-mono uppercase" maxLength={8} placeholder="AAA-1234" error={err('llpin')} {...register('llpin')} />
            </Section>}

            {show('address') && <Section title="Registered address">
              <FormField label="Address line 1" error={err('registered_address.line1')} {...register('registered_address.line1')} />
              <FormField label="Address line 2" {...register('registered_address.line2')} />
              <FormField label="City" error={err('registered_address.city')} {...register('registered_address.city')} />
              <FormField label="State" error={err('registered_address.state')} {...register('registered_address.state')} />
              <FormField label="PIN code" inputMode="numeric" maxLength={6} error={err('registered_address.pincode')} {...register('registered_address.pincode')} />
            </Section>}

            {show('business') && <Section title="Business" description="Used for risk assessment and your partner bank's onboarding.">
              <FormField label="Website" placeholder="https://" error={err('website')} {...register('website')} />
              <FormField label="App URL" placeholder="https://" error={err('app_url')} {...register('app_url')} />
              <FormField label="Business category" error={err('business_category')} {...register('business_category')} />
              <FormField label="MCC" inputMode="numeric" maxLength={4} hint="4-digit merchant category code" error={err('mcc')} {...register('mcc')} />
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="business_description">What does your business sell, and to whom?</Label>
                <Textarea id="business_description" rows={3} aria-invalid={Boolean(err('business_description'))} {...register('business_description')} />
                {err('business_description') && <p className="text-destructive text-xs">{err('business_description')}</p>}
              </div>
            </Section>}

            {show('volumes') && <Section title="Volumes and services" description="Amounts in rupees, e.g. 250000.00">
              <FormField label="Expected monthly volume (₹)" inputMode="decimal" error={err('expected_monthly_volume')} {...register('expected_monthly_volume')} />
              <FormField label="Average ticket size (₹)" inputMode="decimal" error={err('average_ticket_size')} {...register('average_ticket_size')} />
              <FormField label="Maximum ticket size (₹)" inputMode="decimal" error={err('maximum_ticket_size')} {...register('maximum_ticket_size')} />
              <div className="space-y-1.5">
                <Label htmlFor="settlement_preference">Settlement preference</Label>
                <Controller
                  control={control}
                  name="settlement_preference"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={readOnly}>
                      <SelectTrigger id="settlement_preference" className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="T0">T+0 (same day)</SelectItem>
                        <SelectItem value="T1">T+1</SelectItem>
                        <SelectItem value="T2">T+2</SelectItem>
                        <SelectItem value="CUSTOM">Custom</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              {(['payin_required', 'payout_required'] as const).map((f) => (
                <Controller
                  key={f}
                  control={control}
                  name={f}
                  render={({ field }) => (
                    <label className="flex items-center justify-between rounded-lg border p-3">
                      <span className="text-sm">{f === 'payin_required' ? 'Accept payments (Payin)' : 'Send payouts'}</span>
                      <Switch checked={field.value} onCheckedChange={field.onChange} disabled={readOnly} />
                    </label>
                  )}
                />
              ))}
            </Section>}

            {show('contact') && <Section title="Primary contact">
              <FormField label="Name" error={err('contact_name')} {...register('contact_name')} />
              <FormField label="Email" type="email" error={err('contact_email')} {...register('contact_email')} />
              <FormField label="Mobile" inputMode="tel" error={err('contact_mobile')} {...register('contact_mobile')} />
            </Section>}
          </fieldset>
          {!readOnly && (
            <div className="mt-8 flex justify-end">
              <Button type="submit" disabled={formState.isSubmitting || (!onSaved && !formState.isDirty)}>
                {formState.isSubmitting ? <Loader2 className="animate-spin" /> : onSaved ? <ArrowRight /> : <Save />} {onSaved ? 'Save and continue' : 'Save changes'}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
