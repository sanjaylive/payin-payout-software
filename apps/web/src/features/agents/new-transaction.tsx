'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Crown, Landmark, Loader2, Pencil, Plus, Search, UserRound, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { FormError } from '@/components/auth/form-error';
import { api, ApiError } from '@/lib/api/client';
import {
  AMOUNT_RE,
  type AgentBeneficiary,
  type AgentCustomerDetail,
  type AgentDirection,
  type AgentMode,
  type AgentReceipt,
  type AgentTxn,
  type AgentTxnType,
  fmtMobile,
  inr,
  MODE_LABEL,
  MODES,
  newIdempotencyKey,
  rupeesToMinor,
  toAmount,
  TXN_TYPES,
  TYPE_DIRECTION,
  TYPE_LABEL,
} from './api';
import { BeneficiaryForm, CustomerForm } from './customer-forms';
import { AGENT_KEY } from './hooks';
import { ReceiptActions } from './receipt-actions';
import { ReceiptView } from './receipt-view';
import { UpiCollectButton } from './upi-collect';

const MOBILE_RE = /^(?:\+?91|0)?[6-9]\d{9}$/;

export function Segmented<T extends string>({ value, onChange, options, label, id }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string; id?: string }) {
  return (
    <div role="radiogroup" aria-label={label} id={id} className="bg-muted grid auto-cols-fr grid-flow-col gap-1 rounded-lg p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('min-h-10 rounded-md px-2 text-sm font-medium transition-colors', value === o.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface Details {
  amount: string;
  fee: string;
  mode: AgentMode;
  status: 'SUCCESS' | 'PENDING';
  reference: string;
  note: string;
  direction: AgentDirection;
  occurred_at: string;
  quick_name: string;
  quick_mobile: string;
}
const blankDetails = (): Details => ({ amount: '', fee: '', mode: 'CASH', status: 'SUCCESS', reference: '', note: '', direction: 'IN', occurred_at: '', quick_name: '', quick_mobile: '' });

type Step = 'customer' | 'beneficiary' | 'details' | 'review' | 'done';

/**
 * /agent/new: record one counter transaction. Money transfer is guided (customer → beneficiary →
 * amount → review); other types are one screen with an optional customer. Each form carries one
 * Idempotency-Key, so a double tap or a retry on a bad network never records it twice.
 */
export function NewTransaction({ initialType, initialCustomerId }: { initialType?: string | null; initialCustomerId?: string | null }) {
  const qc = useQueryClient();
  const startType: AgentTxnType = TXN_TYPES.includes(initialType as AgentTxnType) ? (initialType as AgentTxnType) : 'MONEY_TRANSFER';
  const [type, setType] = useState<AgentTxnType>(startType);
  const transfer = type === 'MONEY_TRANSFER';
  const [step, setStep] = useState<Step>(transfer ? 'customer' : 'details');
  const [key, setKey] = useState(newIdempotencyKey);
  const [customer, setCustomer] = useState<AgentCustomerDetail | null>(null);
  const [beneficiary, setBeneficiary] = useState<AgentBeneficiary | null>(null);
  const [d, setD] = useState<Details>(blankDetails);
  const [errors, setErrors] = useState<Partial<Record<keyof Details, string>>>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<AgentTxn | null>(null);

  // Prefilled sender (from a customer's page): load once, then go straight to the beneficiary.
  const pre = useQuery({
    queryKey: [...AGENT_KEY, 'customers', initialCustomerId],
    queryFn: () => api.get<AgentCustomerDetail>(`/v1/agent/customers/${initialCustomerId}`),
    enabled: Boolean(initialCustomerId),
    staleTime: Infinity,
  });
  const [preApplied, setPreApplied] = useState(false);
  if (pre.data && !preApplied) {
    setPreApplied(true);
    setCustomer(pre.data);
    if (transfer) setStep('beneficiary');
  }

  const direction: AgentDirection = TYPE_DIRECTION[type] ?? d.direction;
  const set = <K extends keyof Details>(k: K, v: Details[K]) => setD((p) => ({ ...p, [k]: v }));

  function changeType(t: AgentTxnType) {
    setType(t);
    setBeneficiary(null);
    setSubmitError(null);
    setStep(t === 'MONEY_TRANSFER' ? (customer ? 'beneficiary' : 'customer') : 'details');
  }

  function reset() {
    setKey(newIdempotencyKey());
    setCustomer(null);
    setBeneficiary(null);
    setD(blankDetails());
    setErrors({});
    setSubmitError(null);
    setResult(null);
    setStep(transfer ? 'customer' : 'details');
  }

  function validate(): boolean {
    const e: Partial<Record<keyof Details, string>> = {};
    const amount = d.amount.trim().replace(/,/g, '');
    const fee = d.fee.trim().replace(/,/g, '') || '0';
    if (!AMOUNT_RE.test(amount) || Number(amount) < 1) e.amount = 'Enter the amount, at least ₹1';
    if (!AMOUNT_RE.test(fee)) e.fee = 'Enter the fee, or leave it blank';
    else if (direction === 'OUT' && Number(fee) > Number(amount)) e.fee = 'The fee is more than the amount';
    if (d.quick_mobile.trim() && !MOBILE_RE.test(d.quick_mobile.replace(/[\s-]/g, ''))) e.quick_mobile = 'Enter a valid 10-digit mobile number';
    if (d.occurred_at) {
      const t = new Date(d.occurred_at).getTime();
      if (Number.isNaN(t) || t > Date.now() + 60_000) e.occurred_at = 'The time cannot be in the future';
      else if (t < Date.now() - 30 * 86_400_000) e.occurred_at = 'At most 30 days back';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const total = (() => {
    try {
      const a = rupeesToMinor(toAmount(d.amount || '0'));
      const f = rupeesToMinor(toAmount(d.fee || '0'));
      const t = direction === 'IN' ? a + f : a - f;
      if (t < 0n) return '0.00';
      return `${t / 100n}.${String(t % 100n).padStart(2, '0')}`;
    } catch {
      return '0.00';
    }
  })();

  async function save() {
    setSaving(true);
    setSubmitError(null);
    try {
      const body = {
        type,
        ...(type === 'OTHER' ? { direction: d.direction } : {}),
        mode: d.mode,
        status: d.status,
        amount: toAmount(d.amount),
        fee: toAmount(d.fee || '0'),
        reference: d.reference.trim() || null,
        description: d.note.trim() || null,
        ...(customer ? { customer_id: customer.id } : {}),
        ...(beneficiary ? { beneficiary_id: beneficiary.id } : {}),
        ...(!customer && d.quick_name.trim() ? { customer_name: d.quick_name.trim() } : {}),
        ...(!customer && d.quick_mobile.trim() ? { customer_mobile: d.quick_mobile.trim() } : {}),
        ...(d.occurred_at ? { occurred_at: new Date(d.occurred_at).toISOString() } : {}),
      };
      const t = await api.post<AgentTxn>('/v1/agent/transactions', body, { headers: { 'Idempotency-Key': key } });
      setResult(t);
      setStep('done');
      await qc.invalidateQueries({ queryKey: AGENT_KEY });
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSaving(false);
    }
  }

  if (step === 'done' && result) return <Done txn={result} onNew={reset} />;

  const steps: { id: Step; label: string }[] = transfer
    ? [
        { id: 'customer', label: 'Sender' },
        { id: 'beneficiary', label: 'Beneficiary' },
        { id: 'details', label: 'Amount' },
        { id: 'review', label: 'Review' },
      ]
    : [
        { id: 'details', label: 'Details' },
        { id: 'review', label: 'Review' },
      ];
  const stepIndex = steps.findIndex((s) => s.id === step);
  const limitHit = submitError instanceof ApiError && submitError.code === 'LIMIT_EXCEEDED';

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New entry</h1>
        <p className="text-muted-foreground text-sm">Record what you did on the bank portal or UPI app, and give the customer a receipt.</p>
      </div>

      <div className="-mx-4 overflow-x-auto px-4" role="radiogroup" aria-label="Transaction type">
        <div className="flex min-w-max gap-2">
          {TXN_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              disabled={step === 'review'}
              onClick={() => changeType(t)}
              className={cn(
                'min-h-10 rounded-full border px-4 text-sm font-medium transition-colors disabled:opacity-60',
                type === t ? 'bg-primary text-primary-foreground border-primary' : 'bg-card hover:border-primary/50',
              )}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s.id} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                i < stepIndex ? 'bg-primary text-primary-foreground' : i === stepIndex ? 'bg-primary/15 text-primary ring-primary ring-1' : 'bg-muted text-muted-foreground',
              )}
              aria-current={i === stepIndex ? 'step' : undefined}
            >
              {i < stepIndex ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn('truncate', i === stepIndex ? 'font-medium' : 'text-muted-foreground')}>{s.label}</span>
            {i < steps.length - 1 && <span className="bg-border h-px flex-1" aria-hidden />}
          </li>
        ))}
      </ol>

      {step === 'customer' && (
        <Panel title="Who is sending the money?">
          <CustomerPicker
            required
            customer={customer}
            onPick={(c) => {
              setCustomer(c);
              setBeneficiary(null);
              if (c) setStep('beneficiary');
            }}
          />
        </Panel>
      )}

      {step === 'beneficiary' && customer && (
        <Panel title={`Send to whom?`} description={`Beneficiaries of ${customer.name}`}>
          <SelectedCustomer customer={customer} onChange={() => setStep('customer')} />
          <BeneficiaryPicker
            customer={customer}
            selected={beneficiary}
            onSelect={setBeneficiary}
            onAdded={(b) => {
              setCustomer({ ...customer, beneficiaries: [b, ...customer.beneficiaries] });
              setBeneficiary(b);
            }}
          />
          <div className="flex justify-between gap-2 pt-2">
            <Button variant="outline" size="lg" onClick={() => setStep('customer')}>
              <ArrowLeft /> Back
            </Button>
            <Button size="lg" disabled={!beneficiary} onClick={() => setStep('details')}>
              Next <ArrowRight />
            </Button>
          </div>
        </Panel>
      )}

      {step === 'details' && (
        <Panel title={transfer ? 'Amount and payment' : TYPE_LABEL[type]}>
          {transfer && customer && beneficiary && (
            <p className="bg-muted/50 rounded-lg px-3 py-2 text-sm">
              <span className="font-medium">{customer.name}</span> → <span className="font-medium">{beneficiary.name}</span>{' '}
              <span className="text-muted-foreground">({beneficiary.upi_id ?? `${beneficiary.account_masked} · ${beneficiary.ifsc}`})</span>
            </p>
          )}
          {type === 'OTHER' && (
            <div className="space-y-1.5">
              <Label htmlFor="direction">Money</Label>
              <Segmented
                id="direction"
                label="Money in or out"
                value={d.direction}
                onChange={(v) => set('direction', v)}
                options={[
                  { value: 'IN', label: 'In (customer pays me)' },
                  { value: 'OUT', label: 'Out (I pay customer)' },
                ]}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5 sm:col-span-1">
              <Label htmlFor="amount">Amount (₹)</Label>
              <Input
                id="amount"
                inputMode="decimal"
                autoComplete="off"
                autoFocus
                placeholder="0"
                value={d.amount}
                onChange={(e) => set('amount', e.target.value.replace(/[^\d.,]/g, ''))}
                aria-invalid={Boolean(errors.amount)}
                className="h-14 text-2xl font-semibold tabular-nums"
              />
              {errors.amount && <p className="text-destructive text-xs">{errors.amount}</p>}
            </div>
            <div className="col-span-2 space-y-1.5 sm:col-span-1">
              <Label htmlFor="fee">Service charge (₹)</Label>
              <Input
                id="fee"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={d.fee}
                onChange={(e) => set('fee', e.target.value.replace(/[^\d.,]/g, ''))}
                aria-invalid={Boolean(errors.fee)}
                className="h-14 text-2xl tabular-nums"
              />
              {errors.fee && <p className="text-destructive text-xs">{errors.fee}</p>}
            </div>
          </div>
          <div className="bg-muted/50 flex items-center justify-between rounded-lg px-3 py-2 text-sm">
            <span className="text-muted-foreground">{direction === 'IN' ? 'Customer pays' : 'You give the customer'}</span>
            <span className="text-lg font-semibold tabular-nums">{inr(total)}</span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mode">{direction === 'IN' ? 'Customer paid by' : 'Paid to customer by'}</Label>
            <Segmented id="mode" label="Payment mode" value={d.mode} onChange={(v) => set('mode', v)} options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
          </div>
          {direction === 'IN' && d.mode === 'UPI' && <UpiCollectButton amount={toAmount(total)} note={`${TYPE_LABEL[type]}${customer ? ` ${customer.name}` : ''}`} className="h-11 w-full" />}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ref">Reference (UTR / RRN)</Label>
              <Input id="ref" autoComplete="off" maxLength={64} value={d.reference} onChange={(e) => set('reference', e.target.value)} className="h-11 font-mono" placeholder="From the bank portal" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="status">Status</Label>
              <Segmented
                id="status"
                label="Status"
                value={d.status}
                onChange={(v) => set('status', v)}
                options={[
                  { value: 'SUCCESS', label: 'Success' },
                  { value: 'PENDING', label: 'Pending' },
                ]}
              />
            </div>
          </div>
          {!transfer && (
            <fieldset className="space-y-3 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">Customer (optional)</legend>
              {customer ? (
                <SelectedCustomer customer={customer} onChange={() => setCustomer(null)} changeLabel="Remove" />
              ) : (
                <>
                  <CustomerPicker customer={null} onPick={setCustomer} />
                  <p className="text-muted-foreground text-xs">Or just note who it was:</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="qname">Name</Label>
                      <Input id="qname" className="h-11" autoComplete="off" value={d.quick_name} onChange={(e) => set('quick_name', e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="qmobile">Mobile</Label>
                      <Input id="qmobile" className="h-11" type="tel" inputMode="tel" autoComplete="off" value={d.quick_mobile} onChange={(e) => set('quick_mobile', e.target.value)} aria-invalid={Boolean(errors.quick_mobile)} />
                      {errors.quick_mobile && <p className="text-destructive text-xs">{errors.quick_mobile}</p>}
                    </div>
                  </div>
                </>
              )}
            </fieldset>
          )}
          <details className="rounded-lg border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Note and date</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="note">Note</Label>
                <Textarea id="note" rows={2} maxLength={255} value={d.note} onChange={(e) => set('note', e.target.value)} placeholder="Bill number, operator, anything useful" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="when">When (if not now)</Label>
                <Input id="when" type="datetime-local" className="h-11" value={d.occurred_at} onChange={(e) => set('occurred_at', e.target.value)} aria-invalid={Boolean(errors.occurred_at)} />
                {errors.occurred_at ? <p className="text-destructive text-xs">{errors.occurred_at}</p> : <p className="text-muted-foreground text-xs">Up to 30 days back.</p>}
              </div>
            </div>
          </details>
          <div className="flex justify-between gap-2 pt-1">
            {transfer ? (
              <Button variant="outline" size="lg" onClick={() => setStep('beneficiary')}>
                <ArrowLeft /> Back
              </Button>
            ) : (
              <span />
            )}
            <Button size="lg" onClick={() => validate() && setStep('review')}>
              Review <ArrowRight />
            </Button>
          </div>
        </Panel>
      )}

      {step === 'review' && (
        <Panel title="Check and save">
          {limitHit ? (
            <div className="border-warning/40 bg-warning-muted space-y-3 rounded-xl border p-4">
              <p className="flex items-center gap-2 font-medium">
                <Crown className="size-4" aria-hidden /> Monthly limit reached
              </p>
              <p className="text-sm">{(submitError as ApiError).message}</p>
              <Button asChild>
                <Link href="/agent/plan">See plans</Link>
              </Button>
            </div>
          ) : (
            <FormError error={submitError} />
          )}
          <dl className="divide-y rounded-lg border text-sm">
            <ReviewRow label="Type" value={type === 'OTHER' ? `Other (money ${direction === 'IN' ? 'in' : 'out'})` : TYPE_LABEL[type]} />
            {customer ? (
              <ReviewRow label="Customer" value={`${customer.name} · ${fmtMobile(customer.mobile)}`} />
            ) : d.quick_name || d.quick_mobile ? (
              <ReviewRow label="Customer" value={[d.quick_name, d.quick_mobile].filter(Boolean).join(' · ')} />
            ) : null}
            {beneficiary && <ReviewRow label="Beneficiary" value={`${beneficiary.name} · ${beneficiary.upi_id ?? `${beneficiary.account_number ?? beneficiary.account_masked} · ${beneficiary.ifsc}`}`} />}
            <ReviewRow label="Amount" value={inr(toAmount(d.amount))} />
            <ReviewRow label="Service charge" value={inr(toAmount(d.fee || '0'))} />
            <ReviewRow label={direction === 'IN' ? 'Customer pays' : 'Customer gets'} value={<span className="text-base font-semibold">{inr(total)}</span>} />
            <ReviewRow label="Mode" value={MODE_LABEL[d.mode]} />
            {d.reference && <ReviewRow label="Reference" value={<span className="font-mono">{d.reference}</span>} />}
            <ReviewRow label="Status" value={d.status === 'SUCCESS' ? 'Success' : 'Pending'} />
            {d.note && <ReviewRow label="Note" value={d.note} />}
            {d.occurred_at && <ReviewRow label="When" value={new Date(d.occurred_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} />}
          </dl>
          <div className="flex justify-between gap-2 pt-1">
            <Button variant="outline" size="lg" onClick={() => setStep('details')} disabled={saving}>
              <Pencil /> Edit
            </Button>
            <Button size="lg" onClick={() => void save()} disabled={saving || limitHit}>
              {saving ? <Loader2 className="animate-spin" /> : <Check />} Save entry
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="bg-card space-y-4 rounded-xl border p-4 sm:p-5">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right break-all">{value}</dd>
    </div>
  );
}

function SelectedCustomer({ customer, onChange, changeLabel = 'Change' }: { customer: AgentCustomerDetail; onChange: () => void; changeLabel?: string }) {
  return (
    <div className="bg-primary/5 border-primary/20 flex items-center gap-3 rounded-lg border p-3">
      <span className="bg-primary/10 text-primary grid size-10 shrink-0 place-items-center rounded-full">
        <UserRound className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{customer.name}</p>
        <p className="text-muted-foreground truncate text-xs">
          {fmtMobile(customer.mobile)}
          {customer.id_number_masked ? ` · ID ${customer.id_number_masked}` : ''} · {customer.transactions} past {customer.transactions === 1 ? 'entry' : 'entries'}
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={onChange}>
        {changeLabel === 'Remove' ? <X /> : <Pencil />} {changeLabel}
      </Button>
    </div>
  );
}

/** Find a customer by mobile; if new, add them inline (required) or skip (optional). */
function CustomerPicker({ customer, onPick, required }: { customer: AgentCustomerDetail | null; onPick: (c: AgentCustomerDetail | null) => void; required?: boolean }) {
  const [mobile, setMobile] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [found, setFound] = useState<AgentCustomerDetail | null | undefined>(undefined);
  const valid = MOBILE_RE.test(mobile.replace(/[\s-]/g, ''));

  async function lookup() {
    if (!valid) return;
    setSearching(true);
    setError(null);
    try {
      const r = await api.get<{ customer: AgentCustomerDetail | null }>('/v1/agent/customers/lookup', { mobile: mobile.replace(/[\s-]/g, '') });
      setFound(r.customer);
    } catch (err) {
      setError(err);
    } finally {
      setSearching(false);
    }
  }

  if (customer) return <SelectedCustomer customer={customer} onChange={() => onPick(null)} />;
  return (
    <div className="space-y-3">
      <FormError error={error} />
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void lookup();
        }}
      >
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={required ? 'lookup-mobile' : 'lookup-mobile-opt'} className={required ? undefined : 'sr-only'}>
            Customer mobile number
          </Label>
          <Input
            id={required ? 'lookup-mobile' : 'lookup-mobile-opt'}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            autoFocus={required}
            placeholder="Customer mobile, e.g. 98765 43210"
            value={mobile}
            onChange={(e) => {
              setMobile(e.target.value);
              setFound(undefined);
            }}
            className="h-12 text-lg tabular-nums"
          />
        </div>
        <Button type="submit" size="lg" className={cn('h-12', required && 'self-end')} disabled={!valid || searching} variant={required ? 'default' : 'outline'}>
          {searching ? <Loader2 className="animate-spin" /> : <Search />} Find
        </Button>
      </form>
      {found && (
        <div className="space-y-2">
          <SelectedCustomer customer={found} onChange={() => setFound(undefined)} changeLabel="Not them" />
          <Button size="lg" className="w-full" onClick={() => onPick(found)}>
            <Check /> Use {found.name}
          </Button>
        </div>
      )}
      {found === null && (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <p className="text-sm">
            <span className="font-medium">New customer.</span> <span className="text-muted-foreground">Add their details once; next time the mobile number finds them.</span>
          </p>
          <CustomerForm initialMobile={mobile} onSaved={onPick} submitLabel={required ? 'Add and continue' : 'Add customer'} />
        </div>
      )}
    </div>
  );
}

function BeneficiaryPicker({ customer, selected, onSelect, onAdded }: { customer: AgentCustomerDetail; selected: AgentBeneficiary | null; onSelect: (b: AgentBeneficiary) => void; onAdded: (b: AgentBeneficiary) => void }) {
  const list = customer.beneficiaries.filter((b) => b.active);
  const [adding, setAdding] = useState(list.length === 0);
  return (
    <div className="space-y-3">
      {list.length > 0 && (
        <ul className="space-y-2" role="radiogroup" aria-label="Beneficiary">
          {list.map((b) => {
            const on = selected?.id === b.id;
            return (
              <li key={b.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onSelect(b)}
                  className={cn('flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors', on ? 'border-primary bg-primary/5 ring-primary ring-1' : 'hover:border-primary/50')}
                >
                  <span className="bg-muted grid size-10 shrink-0 place-items-center rounded-full">
                    <Landmark className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {b.name}
                      {b.relation ? <span className="text-muted-foreground font-normal"> · {b.relation}</span> : null}
                    </span>
                    {b.account_number && (
                      <span className="text-muted-foreground block truncate font-mono text-xs">
                        {b.account_number} · {b.ifsc}
                        {b.bank_name ? ` · ${b.bank_name}` : ''}
                      </span>
                    )}
                    {b.upi_id && <span className="text-muted-foreground block truncate text-xs">UPI {b.upi_id}</span>}
                  </span>
                  {on && <CheckCircle2 className="text-primary size-5 shrink-0" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <p className="text-sm font-medium">New beneficiary</p>
          <BeneficiaryForm
            customerId={customer.id}
            onSaved={(b) => {
              onAdded(b);
              setAdding(false);
            }}
            onCancel={list.length ? () => setAdding(false) : undefined}
          />
        </div>
      ) : (
        <Button variant="outline" className="h-11 w-full" onClick={() => setAdding(true)}>
          <Plus /> Add beneficiary
        </Button>
      )}
    </div>
  );
}

function Done({ txn, onNew }: { txn: AgentTxn; onNew: () => void }) {
  const router = useRouter();
  const receipt = useQuery({ queryKey: [...AGENT_KEY, 'transactions', txn.id, 'receipt'], queryFn: () => api.get<AgentReceipt>(`/v1/agent/transactions/${txn.id}/receipt`) });
  return (
    <div className="mx-auto max-w-md space-y-5">
      <div className="flex flex-col items-center gap-2 text-center print:hidden">
        <span className="bg-success-muted text-success grid size-14 place-items-center rounded-full">
          <CheckCircle2 className="size-8" aria-hidden />
        </span>
        <h1 className="text-xl font-semibold">Saved · {txn.receipt_no}</h1>
        <p className="text-muted-foreground text-sm">
          {TYPE_LABEL[txn.type]} of {inr(txn.amount)}
          {txn.status === 'PENDING' ? ' marked pending' : ''}. Give the customer their receipt.
        </p>
      </div>
      {receipt.data ? (
        <>
          <ReceiptView receipt={receipt.data} />
          <ReceiptActions receipt={receipt.data} className="print:hidden" />
        </>
      ) : (
        <Skeleton className="h-96 rounded-2xl" />
      )}
      <div className="grid grid-cols-2 gap-2 print:hidden">
        <Button size="lg" onClick={onNew}>
          <Plus /> New entry
        </Button>
        <Button size="lg" variant="outline" onClick={() => router.push('/agent')}>
          Home
        </Button>
      </div>
    </div>
  );
}
