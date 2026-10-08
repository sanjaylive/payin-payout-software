'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { cn } from '@pay2all/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Landmark, Loader2, Pencil, Plus, QrCode, Smartphone, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { CollectionAccount } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { PaymentQr } from '@/features/payin/payment-qr';
import { FUND_ACCOUNTS_KEY, inr, upiPayload, useFundAccounts } from './shared';

function Field({ id, label, hint, children, className }: { id: string; label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-[11px]">{hint}</p>}
    </div>
  );
}

function AccountCard({ a, canEdit, onEdit }: { a: CollectionAccount; canEdit: boolean; onEdit: () => void }) {
  const bank = a.kind === 'BANK';
  return (
    <div className={cn('bg-card flex flex-col overflow-hidden rounded-xl border transition-shadow hover:shadow-md', !a.is_active && 'opacity-60')}>
      <div className={cn('flex items-start justify-between gap-3 p-4 text-white', bank ? 'bg-gradient-to-br from-slate-800 to-slate-950' : 'bg-gradient-to-br from-emerald-600 to-teal-800')}>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase opacity-80">
            {bank ? <Landmark className="size-3.5" /> : <Smartphone className="size-3.5" />}
            {bank ? `${a.bank_name} · ${a.account_type === 'SAVINGS' ? 'Savings' : 'Current'}` : 'UPI'}
          </p>
          <p className="mt-1 truncate text-base font-semibold">{a.label}</p>
          <p className="mt-2 font-mono text-sm tracking-wider">{bank ? a.account_number_masked : a.upi_id}</p>
        </div>
        {canEdit && (
          <Button variant="ghost" size="icon" className="size-8 shrink-0 text-white hover:bg-white/15 hover:text-white" onClick={onEdit} aria-label={`Edit ${a.label}`}>
            <Pencil className="size-4" />
          </Button>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 text-xs">
        <div>
          <dt className="text-muted-foreground">{bank ? 'Account holder' : 'Payee name'}</dt>
          <dd className="truncate font-medium">{bank ? a.account_holder : a.payee_name}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{bank ? 'IFSC' : 'Limits'}</dt>
          <dd className="truncate font-mono font-medium">{bank ? a.ifsc : `${a.min_amount ? inr(a.min_amount) : 'Any'} – ${a.max_amount ? inr(a.max_amount) : 'Any'}`}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pending</dt>
          <dd className="font-medium">{a.pending_requests ?? 0} request{a.pending_requests === 1 ? '' : 's'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Loaded so far</dt>
          <dd className="font-medium tabular-nums">{inr(a.approved_total ?? '0')}</dd>
        </div>
      </dl>
      <div className="text-muted-foreground mt-auto flex items-center justify-between border-t px-4 py-2.5 text-xs">
        <span className={cn('inline-flex items-center gap-1.5 font-medium', a.is_active && 'text-emerald-600 dark:text-emerald-400')}>
          <span className={cn('size-1.5 rounded-full', a.is_active ? 'bg-emerald-500' : 'bg-muted-foreground')} />
          {a.is_active ? 'Shown to merchants' : 'Hidden'}
        </span>
        <span>Order {a.sort_order}</span>
      </div>
    </div>
  );
}

/** Settings → Fund Accounts: the bank accounts and UPI IDs merchants pay into to load their wallet. */
export function FundAccounts() {
  const q = useFundAccounts();
  const can = useCan();
  const canEdit = can('system.settings.manage');
  const [editing, setEditing] = useState<CollectionAccount | 'BANK' | 'UPI' | null>(null);

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">Merchants choose one of these when they add funds. A UPI ID gets a QR code with the amount filled in; a bank account shows its details to copy. Each approved request is booked against the account it was paid into.</p>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing('UPI')}>
              <QrCode className="size-4" /> Add UPI ID
            </Button>
            <Button onClick={() => setEditing('BANK')}>
              <Plus className="size-4" /> Add bank account
            </Button>
          </div>
        )}
      </div>
      {q.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-full">
            <Building2 className="size-6" />
          </span>
          <div>
            <p className="font-semibold">No accounts yet</p>
            <p className="text-muted-foreground text-sm">Add a bank account or UPI ID so merchants can load their wallet.</p>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((a) => (
            <AccountCard key={a.id} a={a} canEdit={canEdit} onEdit={() => setEditing(a)} />
          ))}
        </div>
      )}
      {editing && <AccountDialog key={typeof editing === 'string' ? editing : `${editing.id}:${editing.version}`} account={typeof editing === 'string' ? null : editing} kind={typeof editing === 'string' ? editing : editing.kind} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccountDialog({ account, kind, onClose }: { account: CollectionAccount | null; kind: 'BANK' | 'UPI'; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    label: account?.label ?? '',
    account_holder: account?.account_holder ?? '',
    account_number: '',
    ifsc: account?.ifsc ?? '',
    bank_name: account?.bank_name ?? '',
    branch: account?.branch ?? '',
    account_type: account?.account_type ?? 'CURRENT',
    upi_id: account?.upi_id ?? '',
    payee_name: account?.payee_name ?? '',
    min_amount: account?.min_amount ?? '',
    max_amount: account?.max_amount ?? '',
    instructions: account?.instructions ?? '',
    is_active: account?.is_active ?? true,
    sort_order: String(account?.sort_order ?? 100),
    reason: '',
  });
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const set = (k: keyof typeof f, v: string | boolean) => setF((cur) => ({ ...cur, [k]: v }));
  const bank = kind === 'BANK';

  async function run(action: 'save' | 'remove') {
    setBusy(action);
    try {
      if (action === 'remove') {
        await api.post(`/v1/funds/accounts/${account!.id}/remove`, { reason: f.reason });
        toast.success('Account removed');
      } else {
        const common = {
          label: f.label,
          min_amount: f.min_amount.trim() || null,
          max_amount: f.max_amount.trim() || null,
          instructions: f.instructions,
          is_active: f.is_active,
          sort_order: Number(f.sort_order) || 0,
          reason: f.reason,
        };
        const body = bank
          ? { kind, ...common, account_holder: f.account_holder, ...(f.account_number ? { account_number: f.account_number } : {}), ifsc: f.ifsc, bank_name: f.bank_name, branch: f.branch, account_type: f.account_type }
          : { kind, ...common, upi_id: f.upi_id.trim(), payee_name: f.payee_name };
        if (account) await api.put(`/v1/funds/accounts/${account.id}`, { ...body, version: account.version });
        else await api.post('/v1/funds/accounts', body);
        toast.success(account ? 'Account saved' : 'Account added — merchants can pay into it now');
      }
      await qc.invalidateQueries({ queryKey: FUND_ACCOUNTS_KEY });
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const valid = f.label.trim().length >= 2 && f.reason.trim().length >= 5 && (bank ? f.account_holder.trim() && f.ifsc.trim() && f.bank_name.trim() && (account || f.account_number.trim()) : f.upi_id.includes('@') && f.payee_name.trim());

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {bank ? <Landmark className="size-5" /> : <Smartphone className="size-5" />}
            {account ? `Edit ${account.label}` : bank ? 'Add bank account' : 'Add UPI ID'}
          </DialogTitle>
          <DialogDescription>{bank ? 'Merchants transfer by IMPS, NEFT or RTGS and copy these details.' : 'Merchants scan a QR code with the amount already filled in.'}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="fa-label" label="Label" hint="What merchants see, e.g. “HDFC — Collections”" className="sm:col-span-2">
            <Input id="fa-label" value={f.label} onChange={(e) => set('label', e.target.value)} maxLength={80} />
          </Field>
          {bank ? (
            <>
              <Field id="fa-holder" label="Account holder name">
                <Input id="fa-holder" value={f.account_holder} onChange={(e) => set('account_holder', e.target.value)} maxLength={120} />
              </Field>
              <Field id="fa-number" label="Account number" hint={account ? `Saved: ${account.account_number_masked}. Leave empty to keep it.` : 'Stored encrypted'}>
                <Input id="fa-number" value={f.account_number} onChange={(e) => set('account_number', e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={18} placeholder={account ? '••••••••' : ''} autoComplete="off" />
              </Field>
              <Field id="fa-ifsc" label="IFSC">
                <Input id="fa-ifsc" value={f.ifsc} onChange={(e) => set('ifsc', e.target.value.toUpperCase())} maxLength={11} className="font-mono" placeholder="HDFC0001234" />
              </Field>
              <Field id="fa-bank" label="Bank name">
                <Input id="fa-bank" value={f.bank_name} onChange={(e) => set('bank_name', e.target.value)} maxLength={80} />
              </Field>
              <Field id="fa-branch" label="Branch (optional)">
                <Input id="fa-branch" value={f.branch} onChange={(e) => set('branch', e.target.value)} maxLength={120} />
              </Field>
              <div className="space-y-1.5">
                <Label>Account type</Label>
                <div className="bg-muted grid h-9 grid-cols-2 rounded-md p-0.5" role="radiogroup" aria-label="Account type">
                  {(['CURRENT', 'SAVINGS'] as const).map((t) => (
                    <button key={t} type="button" role="radio" aria-checked={f.account_type === t} onClick={() => set('account_type', t)} className={cn('rounded text-xs font-medium', f.account_type === t ? 'bg-background shadow-sm' : 'text-muted-foreground')}>
                      {t === 'CURRENT' ? 'Current' : 'Savings'}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <Field id="fa-upi" label="UPI ID">
                <Input id="fa-upi" value={f.upi_id} onChange={(e) => set('upi_id', e.target.value.trim())} placeholder="business@hdfcbank" className="font-mono" />
              </Field>
              <Field id="fa-payee" label="Payee name" hint="Shown in the payer’s UPI app">
                <Input id="fa-payee" value={f.payee_name} onChange={(e) => set('payee_name', e.target.value)} maxLength={100} />
              </Field>
              {f.upi_id.includes('@') && (
                <div className="bg-muted/40 flex items-center gap-4 rounded-lg border p-3 sm:col-span-2">
                  <PaymentQr payload={upiPayload({ upi_id: f.upi_id, payee_name: f.payee_name }, '1', 'Test payment')} size={96} />
                  <p className="text-muted-foreground text-xs">Scan with any UPI app to check the name before publishing — it opens a ₹1 test payment (don’t complete it unless you want to).</p>
                </div>
              )}
            </>
          )}
          <Field id="fa-min" label="Minimum amount (optional)">
            <Input id="fa-min" value={f.min_amount} onChange={(e) => set('min_amount', e.target.value)} inputMode="decimal" placeholder="e.g. 100" />
          </Field>
          <Field id="fa-max" label="Maximum amount (optional)">
            <Input id="fa-max" value={f.max_amount} onChange={(e) => set('max_amount', e.target.value)} inputMode="decimal" placeholder="e.g. 200000" />
          </Field>
          <Field id="fa-instr" label="Instructions for merchants (optional)" className="sm:col-span-2">
            <Input id="fa-instr" value={f.instructions} onChange={(e) => set('instructions', e.target.value)} maxLength={300} placeholder="e.g. Use your merchant ID as the transfer remark" />
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3 sm:col-span-2">
            <div>
              <p className="text-sm font-medium">Show to merchants</p>
              <p className="text-muted-foreground text-xs">Hidden accounts keep their history but can’t receive new requests.</p>
            </div>
            <div className="flex items-center gap-3">
              <Input aria-label="Display order" value={f.sort_order} onChange={(e) => set('sort_order', e.target.value.replace(/\D/g, ''))} className="h-8 w-16 text-center" title="Display order (lower first)" />
              <Switch checked={f.is_active} onCheckedChange={(v) => set('is_active', v)} aria-label="Show to merchants" />
            </div>
          </div>
          <Field id="fa-reason" label="Reason for this change" className="sm:col-span-2">
            <Textarea id="fa-reason" rows={2} value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Recorded in the audit log" />
          </Field>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {account && (account.pending_requests ?? 0) === 0 && account.approved_total === '0.00' ? (
            <Button variant="ghost" className="text-destructive" disabled={!!busy || f.reason.trim().length < 5} onClick={() => void run('remove')}>
              {busy === 'remove' ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!valid || !!busy} onClick={() => void run('save')}>
              {busy === 'save' && <Loader2 className="size-4 animate-spin" />} {account ? 'Save' : 'Add account'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
