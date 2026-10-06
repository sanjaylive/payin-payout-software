'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Badge } from '@pay2all/ui/components/ui/badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Checkbox } from '@pay2all/ui/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantApplication } from '@/lib/api/types';
import { useInvalidateMerchant } from './use-merchant';

interface PersonForm {
  full_name: string;
  designation: string;
  pan: string;
  din: string;
  email: string;
  mobile: string;
  ownership_percent: string;
  is_director: boolean;
  is_ubo: boolean;
  is_authorized_signatory: boolean;
}

const blank: PersonForm = { full_name: '', designation: '', pan: '', din: '', email: '', mobile: '', ownership_percent: '', is_director: true, is_ubo: false, is_authorized_signatory: false };

function AddPersonDialog({ merchantId, open, onOpenChange }: { merchantId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateMerchant(merchantId);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<PersonForm>({ defaultValues: blank });
  const err = (p: keyof PersonForm) => form.formState.errors[p]?.message;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const body = Object.fromEntries(
      Object.entries({ ...v, pan: v.pan.toUpperCase() }).filter(([, val]) => val !== ''),
    );
    try {
      await api.post(`/v1/merchants/${merchantId}/persons`, body);
      toast.success(`${v.full_name} added`);
      form.reset(blank);
      onOpenChange(false);
      await invalidate();
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) for (const d of e.details) form.setError(d.path as keyof PersonForm, { message: d.message });
      else setError(e);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a person</DialogTitle>
          <DialogDescription>Directors, partners, proprietors, beneficial owners and authorized signatories. PAN is stored encrypted.</DialogDescription>
        </DialogHeader>
        <FormError error={error} />
        <form id="person-form" onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <FormField label="Full name (as on PAN)" error={err('full_name')} {...form.register('full_name')} />
          <FormField label="Designation" {...form.register('designation')} />
          <FormField label="PAN" className="font-mono uppercase" maxLength={10} error={err('pan')} {...form.register('pan')} />
          <FormField label="DIN (directors)" inputMode="numeric" maxLength={8} error={err('din')} {...form.register('din')} />
          <FormField label="Email" type="email" error={err('email')} {...form.register('email')} />
          <FormField label="Mobile" inputMode="tel" error={err('mobile')} {...form.register('mobile')} />
          <FormField label="Ownership %" inputMode="decimal" placeholder="e.g. 51.00" error={err('ownership_percent')} {...form.register('ownership_percent')} />
          <div className="space-y-2 sm:col-span-2">
            {([['is_director', 'Director / partner / proprietor'], ['is_ubo', 'Ultimate beneficial owner'], ['is_authorized_signatory', 'Authorized signatory']] as const).map(([name, label]) => (
              <Controller
                key={name}
                control={form.control}
                name={name}
                render={({ field }) => (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={field.value} onCheckedChange={(c) => field.onChange(c === true)} /> {label}
                  </label>
                )}
              />
            ))}
            {err('is_director') && <p className="text-destructive text-xs">{err('is_director')}</p>}
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="person-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />} Add person
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PeopleSection({ app, canEdit }: { app: MerchantApplication; canEdit: boolean }) {
  const invalidate = useInvalidateMerchant(app.id);
  const [open, setOpen] = useState(false);

  async function remove(id: string) {
    try {
      await api.delete(`/v1/merchants/${app.id}/persons/${id}`);
      toast.success('Removed');
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Directors, owners and signatories</CardTitle>
          <CardDescription>Declare everyone who controls or owns the business.</CardDescription>
        </div>
        {canEdit && <Button variant="outline" onClick={() => setOpen(true)}><Plus /> Add person</Button>}
      </CardHeader>
      <CardContent>
        <DataTable
          rows={app.persons}
          rowKey={(p) => p.id}
          empty={{ title: 'No people added yet', description: 'Add at least one director, partner or proprietor.' }}
          columns={[
            { id: 'name', header: 'Name', cell: (p) => <div><p className="font-medium">{p.full_name}</p><p className="text-muted-foreground text-xs">{p.designation ?? ''}</p></div> },
            { id: 'pan', header: 'PAN', cell: (p) => <span className="font-mono text-xs">{p.pan_masked}</span> },
            {
              id: 'roles',
              header: 'Roles',
              cell: (p) => (
                <div className="flex flex-wrap gap-1">
                  {p.is_director && <Badge variant="secondary">Director</Badge>}
                  {p.is_ubo && <Badge variant="secondary">UBO{p.ownership_percent ? ` · ${p.ownership_percent}%` : ''}</Badge>}
                  {p.is_authorized_signatory && <Badge variant="secondary">Signatory</Badge>}
                </div>
              ),
            },
            { id: 'kyc', header: 'KYC', cell: (p) => <StatusBadge status={p.kyc_status} /> },
            { id: 'a', header: '', align: 'right', cell: (p) => (canEdit ? <Button variant="ghost" size="icon" aria-label={`Remove ${p.full_name}`} onClick={() => void remove(p.id)}><Trash2 /></Button> : null) },
          ]}
        />
      </CardContent>
      <AddPersonDialog merchantId={app.id} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
