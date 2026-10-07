'use client';

import { cn } from '@pay2all/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Minus } from 'lucide-react';
import { majorToMinor } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import type { PricingProviderRow, PricingService, SchemeList } from '@/lib/api/types';

export const PROVIDERS_KEY = ['pricing-providers'];
export const SCHEMES_KEY = ['schemes'];

export const usePricingProviders = () => useQuery({ queryKey: PROVIDERS_KEY, queryFn: () => api.get<PricingProviderRow[]>('/v1/pricing-providers') });
export const useSchemes = () => useQuery({ queryKey: SCHEMES_KEY, queryFn: () => api.get<SchemeList>('/v1/schemes') });

export const PRICING_METHODS: Record<PricingService, { value: string; label: string }[]> = {
  PAYIN: [
    { value: 'UPI_QR', label: 'UPI QR' },
    { value: 'UPI_INTENT', label: 'UPI intent' },
    { value: 'UPI_STATIC_QR', label: 'Static QR' },
    { value: 'PAYMENT_LINK', label: 'Payment link' },
    { value: 'VIRTUAL_ACCOUNT', label: 'Virtual account' },
    { value: 'CARD', label: 'Card' },
    { value: 'NETBANKING', label: 'Netbanking' },
  ],
  PAYOUT: [
    { value: 'IMPS', label: 'IMPS' },
    { value: 'NEFT', label: 'NEFT' },
    { value: 'RTGS', label: 'RTGS' },
    { value: 'UPI', label: 'UPI' },
  ],
};
export const methodLabel = (m: string) => [...PRICING_METHODS.PAYIN, ...PRICING_METHODS.PAYOUT].find((x) => x.value === m)?.label ?? m;

/** "#2" chip used wherever a pricing provider is shown. */
export function ProviderNo({ id, className }: { id: number; className?: string }) {
  return <span className={cn('bg-primary/10 text-primary inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 font-mono text-xs font-semibold tabular-nums', className)}>#{id}</span>;
}

export function ServiceTag({ service }: { service: PricingService }) {
  const Icon = service === 'PAYIN' ? ArrowDownLeft : ArrowUpRight;
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium">
      <Icon className="size-3.5" />
      {service === 'PAYIN' ? 'Payin' : 'Payout'}
    </span>
  );
}

const inr = (minor: bigint) => `₹${(Number(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const rupees = (major: string) => inr(majorToMinor(major));

/** Signed value → what it means. "-2" FLAT → Charge ₹2.00; "0.5" PERCENT → Commission 0.5 %. */
export function describeValue(type: 'PERCENT' | 'FLAT', value: string): { kind: 'CHARGE' | 'COMMISSION' | 'FREE' | 'INVALID'; text: string } {
  if (!/^-?\d{1,6}(\.\d{1,6})?$/.test(value.trim())) return { kind: 'INVALID', text: 'Enter a number' };
  const v = value.trim();
  const abs = v.replace('-', '');
  if (/^0*(\.0*)?$/.test(abs)) return { kind: 'FREE', text: 'Free' };
  const shown = type === 'FLAT' ? rupees(abs) : `${abs.replace(/\.?0+$/, '')} %`;
  return v.startsWith('-') ? { kind: 'CHARGE', text: `Charge ${shown}` } : { kind: 'COMMISSION', text: `Commission ${shown}` };
}

export function ValueBadge({ type, value, onFlip }: { type: 'PERCENT' | 'FLAT'; value: string; onFlip?: () => void }) {
  const d = describeValue(type, value);
  const Icon = d.kind === 'CHARGE' ? ArrowUpRight : d.kind === 'COMMISSION' ? ArrowDownLeft : Minus;
  const cls = {
    CHARGE: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/20',
    COMMISSION: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20',
    FREE: 'bg-muted text-muted-foreground ring-border',
    INVALID: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/20',
  }[d.kind];
  const body = (
    <>
      <Icon className="size-3" />
      {d.text}
    </>
  );
  const base = cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', cls);
  return onFlip && (d.kind === 'CHARGE' || d.kind === 'COMMISSION') ? (
    <button type="button" onClick={onFlip} className={cn(base, 'hover:opacity-80')} title={d.kind === 'CHARGE' ? 'Make it a commission' : 'Make it a charge'}>
      {body}
    </button>
  ) : (
    <span className={base}>{body}</span>
  );
}

// ---- Client-side preview (same rules as the API: HALF_UP once per component) -----------------------

const RATE_SCALE = 1_000_000n;
function parseMicros(abs: string): bigint {
  const [w = '0', f = ''] = abs.split('.');
  return BigInt(w) * RATE_SCALE + BigInt((f + '000000').slice(0, 6));
}
const halfUp = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);
/** percent-of with rate micros, e.g. 0.5 % = 500000 → amount × 500000 / 100 000 000. */
const pct = (amount: bigint, micros: bigint) => halfUp(amount * micros, 100n * RATE_SCALE);

export interface DraftRate {
  min: string;
  max: string;
  type: 'PERCENT' | 'FLAT';
  value: string;
}

export function previewDraft(rates: DraftRate[], amountMajor: string, taxRate: string, service: PricingService) {
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(amountMajor)) return null;
  const amount = majorToMinor(amountMajor);
  const rate = rates.find((r) => /^\d+(\.\d{1,2})?$/.test(r.min) && amount >= majorToMinor(r.min) && (r.max.trim() === '' || (/^\d+(\.\d{1,2})?$/.test(r.max) && amount <= majorToMinor(r.max))));
  if (!rate) return { matched: false as const };
  const d = describeValue(rate.type, rate.value);
  if (d.kind === 'INVALID') return { matched: false as const };
  const abs = rate.value.trim().replace('-', '');
  const v = rate.type === 'FLAT' ? majorToMinor(abs) : pct(amount, parseMicros(abs));
  const fee = d.kind === 'CHARGE' ? v : 0n;
  const commission = d.kind === 'COMMISSION' ? v : 0n;
  const tax = /^\d{1,3}(\.\d{1,4})?$/.test(taxRate) ? pct(fee, parseMicros(taxRate)) : 0n;
  const net = service === 'PAYIN' ? amount - fee - tax + commission : amount + fee + tax - commission;
  return { matched: true as const, fee: inr(fee), tax: inr(tax), commission: inr(commission), net: inr(net), kind: d.kind };
}
