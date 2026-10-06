'use client';

import { BankAccountDisplay } from '@pay2all/ui/components/bank-account-display';
import { EmptyState } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { AlertTriangle, Landmark, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api, ApiError } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantApplication, MerchantBankAccount } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { useInvalidateMerchant } from './use-merchant';

interface BankForm {
  account_holder_name: string;
  account_number: string;
  confirm_account_number: string;
  ifsc: string;
  bank_name: string;
}

function AddBankDialog({ merchantId, open, onOpenChange }: { merchantId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateMerchant(merchantId);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<BankForm>({ defaultValues: { account_holder_name: '', account_number: '', confirm_account_number: '', ifsc: '', bank_name: '' } });
  const err = (p: keyof BankForm) => form.formState.errors[p]?.message;

  const onSubmit = form.handleSubmit(async ({ confirm_account_number, ...v }) => {
    setError(null);
    if (confirm_account_number !== v.account_number) {
      form.setError('confirm_account_number', { message: 'Account numbers do not match' });
      return;
    }
    try {
      await api.post(`/v1/merchants/${merchantId}/bank-accounts`, { ...v, ifsc: v.ifsc.toUpperCase(), ...(v.bank_name ? {} : { bank_name: undefined }) });
      toast.success('Bank account added');
      form.reset();
      onOpenChange(false);
      await invalidate();
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) for (const d of e.details) form.setError(d.path as keyof BankForm, { message: d.message });
      else setError(e);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add settlement account</DialogTitle>
          <DialogDescription>The account must be in the business&apos;s name. It is stored encrypted and verified before use.</DialogDescription>
        </DialogHeader>
        <FormError error={error} />
        <form id="bank-form" onSubmit={onSubmit} className="space-y-4" noValidate autoComplete="off">
          <FormField label="Account holder name" error={err('account_holder_name')} {...form.register('account_holder_name')} />
          <FormField label="Account number" inputMode="numeric" error={err('account_number')} {...form.register('account_number')} />
          {/* Re-entry guards against typos in a field that routes real money. */}
          <FormField label="Confirm account number" inputMode="numeric" onPaste={(e) => e.preventDefault()} error={err('confirm_account_number')} {...form.register('confirm_account_number')} />
          <FormField label="IFSC" className="font-mono uppercase" maxLength={11} error={err('ifsc')} {...form.register('ifsc')} />
          <FormField label="Bank name (optional)" {...form.register('bank_name')} />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="bank-form" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />} Add account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VerifyDialog({ merchantId, account, onClose }: { merchantId: string; account: MerchantBankAccount | null; onClose: () => void }) {
  const invalidate = useInvalidateMerchant(merchantId);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  async function decide(status: 'VERIFIED' | 'FAILED') {
    if (!account) return;
    setBusy(true);
    try {
      await api.post(`/v1/merchants/${merchantId}/bank-accounts/${account.id}/verification`, { status, reference });
      toast.success(status === 'VERIFIED' ? 'Account verified' : 'Verification marked failed');
      setReference('');
      onClose();
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(account)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Verify bank account</DialogTitle>
          <DialogDescription>Record the penny-drop / name-match reference. Automated verification arrives with provider integrations.</DialogDescription>
        </DialogHeader>
        {account && <BankAccountDisplay holderName={account.account_holder_name} accountNumberMasked={account.account_number_masked} ifsc={account.ifsc} bankName={account.bank_name} />}
        <FormField label="Verification reference" name="reference" value={reference} onChange={(e) => setReference(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" disabled={busy || reference.trim().length < 3} onClick={() => void decide('FAILED')}>Mark failed</Button>
          <Button disabled={busy || reference.trim().length < 3} onClick={() => void decide('VERIFIED')}>Verify</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BankAccountsSection({ app, canEdit }: { app: MerchantApplication; canEdit: boolean }) {
  const can = useCan();
  const invalidate = useInvalidateMerchant(app.id);
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<MerchantBankAccount | null>(null);
  const canAdd = canEdit || (can('merchant.update') && app.status === 'APPROVED');

  async function act(fn: () => Promise<unknown>, msg: string) {
    try {
      await fn();
      toast.success(msg);
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Settlement bank accounts</CardTitle>
          <CardDescription>Settlements are paid only to the verified primary account.</CardDescription>
        </div>
        {canAdd && <Button variant="outline" onClick={() => setAdding(true)}><Plus /> Add account</Button>}
      </CardHeader>
      <CardContent className="space-y-3">
        {app.bank_accounts.length === 0 && <EmptyState icon={Landmark} title="No bank account yet" className="py-8" />}
        {app.bank_accounts.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-3">
            <BankAccountDisplay className="min-w-72 flex-1" holderName={b.account_holder_name} accountNumberMasked={b.account_number_masked} ifsc={b.ifsc} bankName={b.bank_name} />
            <div className="flex flex-wrap items-center gap-2">
              {b.is_primary && <StatusBadge status="PRIMARY" tone="primary" />}
              <StatusBadge status={b.verification_status} />
              {b.shared_with_other_merchants && (
                <span className="text-destructive flex items-center gap-1 text-xs font-medium"><AlertTriangle className="size-3.5" /> Also registered to another merchant</span>
              )}
              {!b.is_primary && canAdd && <Button size="sm" variant="ghost" onClick={() => void act(() => api.post(`/v1/merchants/${app.id}/bank-accounts/${b.id}/primary`), 'Primary account updated')}>Make primary</Button>}
              {!b.is_primary && canAdd && <Button size="sm" variant="ghost" onClick={() => void act(() => api.delete(`/v1/merchants/${app.id}/bank-accounts/${b.id}`), 'Account removed')}>Remove</Button>}
              {can('compliance.approve') && b.verification_status === 'PENDING' && <Button size="sm" onClick={() => setVerifying(b)}>Verify</Button>}
            </div>
          </div>
        ))}
      </CardContent>
      <AddBankDialog merchantId={app.id} open={adding} onOpenChange={setAdding} />
      <VerifyDialog merchantId={app.id} account={verifying} onClose={() => setVerifying(null)} />
    </Card>
  );
}
