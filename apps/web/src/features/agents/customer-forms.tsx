'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@pay2all/ui/components/ui/button';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { agentBeneficiarySchema, agentCustomerSchema } from '@pay2all/validation';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, Save, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api, ApiError } from '@/lib/api/client';
import { type AgentBeneficiary, type AgentCustomerDetail, ID_TYPE_LABEL, ID_TYPES } from './api';
import { AGENT_KEY } from './hooks';

type CustomerValues = z.input<typeof agentCustomerSchema>;
type BeneficiaryValues = z.input<typeof agentBeneficiarySchema>;

function applyServerErrors<T extends Record<string, unknown>>(err: unknown, setError: (path: keyof T & string, e: { message: string }) => void) {
  if (err instanceof ApiError && err.details?.length) for (const d of err.details) setError(d.path as keyof T & string, { message: d.message });
}

/**
 * Add or edit a customer. On edit the ID number field starts blank (only the last 4 are kept in
 * view) and is left unchanged unless the agent types a new one.
 */
export function CustomerForm({
  customer,
  initialMobile,
  onSaved,
  onCancel,
  submitLabel,
}: {
  customer?: AgentCustomerDetail;
  initialMobile?: string;
  onSaved: (c: AgentCustomerDetail) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(Boolean(customer && (customer.email || customer.address_line || customer.id_type || customer.date_of_birth)));
  const form = useForm<CustomerValues, unknown, z.output<typeof agentCustomerSchema>>({
    resolver: zodResolver(agentCustomerSchema),
    defaultValues: {
      name: customer?.name ?? '',
      mobile: customer?.mobile.replace(/^\+91/, '') ?? initialMobile ?? '',
      email: customer?.email ?? '',
      address_line: customer?.address_line ?? '',
      city: customer?.city ?? '',
      pincode: customer?.pincode ?? '',
      date_of_birth: customer?.date_of_birth ?? '',
      id_type: customer?.id_type ?? null,
      id_number: '',
      note: customer?.note ?? '',
    },
  });
  const e = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const body: Record<string, unknown> = { ...v };
      if (customer && !body.id_number) delete body.id_number;
      const saved = customer ? await api.patch<AgentCustomerDetail>(`/v1/agent/customers/${customer.id}`, body) : await api.post<AgentCustomerDetail>('/v1/agent/customers', body);
      toast.success(customer ? 'Customer updated' : `${saved.name} added`);
      await qc.invalidateQueries({ queryKey: AGENT_KEY });
      onSaved(saved);
    } catch (err) {
      applyServerErrors<CustomerValues>(err, form.setError);
      setError(err);
    }
  });

  return (
    <form onSubmit={(ev) => void submit(ev)} className="space-y-4" noValidate>
      <FormError error={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="cust-name" label="Customer name" autoComplete="off" error={e.name?.message} {...form.register('name')} />
        <FormField id="cust-mobile" label="Mobile number" type="tel" inputMode="tel" autoComplete="off" placeholder="98765 43210" error={e.mobile?.message} {...form.register('mobile')} />
      </div>
      <button type="button" className="text-primary inline-flex items-center gap-1 text-sm font-medium" onClick={() => setMore((m) => !m)} aria-expanded={more}>
        <ChevronDown className={`size-4 transition-transform ${more ? 'rotate-180' : ''}`} aria-hidden /> {more ? 'Fewer details' : 'More details (optional)'}
      </button>
      {more && (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="cust-email" label="Email" type="email" autoComplete="off" error={e.email?.message} {...form.register('email')} />
          <FormField id="cust-dob" label="Date of birth" type="date" error={e.date_of_birth?.message} {...form.register('date_of_birth')} />
          <div className="sm:col-span-2">
            <FormField id="cust-address" label="Address" autoComplete="off" error={e.address_line?.message} {...form.register('address_line')} />
          </div>
          <FormField id="cust-city" label="City / village" autoComplete="off" error={e.city?.message} {...form.register('city')} />
          <FormField id="cust-pin" label="PIN code" inputMode="numeric" maxLength={6} autoComplete="off" error={e.pincode?.message} {...form.register('pincode')} />
          <div className="space-y-1.5">
            <Label htmlFor="cust-idtype">ID document</Label>
            <Controller
              control={form.control}
              name="id_type"
              render={({ field }) => (
                <Select value={field.value ?? 'NONE'} onValueChange={(v) => field.onChange(v === 'NONE' ? null : v)}>
                  <SelectTrigger id="cust-idtype" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">None</SelectItem>
                    {ID_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {ID_TYPE_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <FormField
            id="cust-idno"
            label="ID number"
            autoComplete="off"
            className="uppercase"
            hint={customer?.id_number_masked ? `Saved: ${customer.id_number_masked}. Leave blank to keep it.` : 'Stored encrypted; lists show the last 4 only'}
            error={e.id_number?.message}
            {...form.register('id_number')}
          />
          <div className="sm:col-span-2">
            <FormField id="cust-note" label="Note" autoComplete="off" error={e.note?.message} {...form.register('note')} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" size="lg" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="lg" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : customer ? <Save /> : <UserPlus />} {submitLabel ?? (customer ? 'Save changes' : 'Add customer')}
        </Button>
      </div>
    </form>
  );
}

/** Add a beneficiary (bank account + IFSC and/or UPI id) for one customer. */
export function BeneficiaryForm({ customerId, onSaved, onCancel }: { customerId: string; onSaved: (b: AgentBeneficiary) => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<BeneficiaryValues, unknown, z.output<typeof agentBeneficiarySchema>>({
    resolver: zodResolver(agentBeneficiarySchema),
    defaultValues: { name: '', bank_name: '', account_number: '', ifsc: '', upi_id: '', relation: '' },
  });
  const e = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const b = await api.post<AgentBeneficiary>(`/v1/agent/customers/${customerId}/beneficiaries`, v);
      toast.success(`${b.name} added`);
      await qc.invalidateQueries({ queryKey: AGENT_KEY });
      form.reset();
      onSaved(b);
    } catch (err) {
      applyServerErrors<BeneficiaryValues>(err, form.setError);
      setError(err);
    }
  });
  return (
    <form onSubmit={(ev) => void submit(ev)} className="space-y-4" noValidate>
      <FormError error={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="ben-name" label="Name as per bank" autoComplete="off" error={e.name?.message} {...form.register('name')} />
        <FormField id="ben-relation" label="Relation (optional)" placeholder="Son, brother, self…" autoComplete="off" error={e.relation?.message} {...form.register('relation')} />
        <FormField id="ben-account" label="Account number" inputMode="numeric" autoComplete="off" error={e.account_number?.message} {...form.register('account_number')} />
        <FormField id="ben-ifsc" label="IFSC" autoComplete="off" className="uppercase" placeholder="SBIN0001234" error={e.ifsc?.message} {...form.register('ifsc')} />
        <FormField id="ben-bank" label="Bank name (optional)" autoComplete="off" error={e.bank_name?.message} {...form.register('bank_name')} />
        <FormField id="ben-upi" label="UPI id (optional)" placeholder="name@bank" autoComplete="off" hint="Enter an account, a UPI id, or both" error={e.upi_id?.message} {...form.register('upi_id')} />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" size="lg" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="lg" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : <UserPlus />} Add beneficiary
        </Button>
      </div>
    </form>
  );
}
