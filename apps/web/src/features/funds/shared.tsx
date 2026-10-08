'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Check, CheckCircle2, Clock3, Copy, Undo2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, buildUrl } from '@/lib/api/client';
import type { CollectionAccount, FundRequest, FundRequestStatus, FundSummary } from '@/lib/api/types';
import { useAuthStore } from '@/lib/auth/store';

export const FUND_ACCOUNTS_KEY = ['fund-accounts'];
export const FUND_REQUESTS_KEY = ['fund-requests'];
export const FUND_SUMMARY_KEY = ['fund-summary'];

export const useFundAccounts = () => useQuery({ queryKey: FUND_ACCOUNTS_KEY, queryFn: () => api.get<CollectionAccount[]>('/v1/funds/accounts') });
export const useFundSummary = () => useQuery({ queryKey: FUND_SUMMARY_KEY, queryFn: () => api.get<FundSummary>('/v1/funds/summary'), refetchInterval: 30_000 });

export const MODE_LABEL: Record<FundRequest['mode'], string> = { UPI: 'UPI', IMPS: 'IMPS', NEFT: 'NEFT', RTGS: 'RTGS', CASH_DEPOSIT: 'Cash deposit', OTHER: 'Other' };

export const inr = (major: string | null | undefined) =>
  major === null || major === undefined ? '—' : `₹${Number(major).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS: Record<FundRequestStatus, { label: string; cls: string; icon: typeof Clock3 }> = {
  PENDING: { label: 'Pending', cls: 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300', icon: Clock3 },
  APPROVED: { label: 'Approved', cls: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300', icon: CheckCircle2 },
  REJECTED: { label: 'Rejected', cls: 'bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-300', icon: XCircle },
  CANCELLED: { label: 'Cancelled', cls: 'bg-muted text-muted-foreground ring-border', icon: Undo2 },
};

export function FundStatus({ status }: { status: FundRequestStatus }) {
  const s = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', s.cls)}>
      <s.icon className="size-3" /> {s.label}
    </span>
  );
}

export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('size-7 shrink-0', className)}
      aria-label={`Copy ${label}`}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(
          () => {
            setDone(true);
            toast.success(`${label} copied`);
            setTimeout(() => setDone(false), 1500);
          },
          () => toast.error('Could not copy'),
        )
      }
    >
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

/** UPI deep link (NPCI "upi://pay"): payee address, name, amount and a note. */
export function upiPayload(a: Pick<CollectionAccount, 'upi_id' | 'payee_name'>, amount: string, note: string) {
  const parts = [`pa=${a.upi_id}`, `pn=${encodeURIComponent(a.payee_name ?? '')}`, `cu=INR`, `tn=${encodeURIComponent(note.slice(0, 50))}`];
  if (/^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0) parts.splice(2, 0, `am=${Number(amount).toFixed(2)}`);
  return `upi://pay?${parts.join('&')}`;
}

/** Loads an authenticated file (payment proof) as an object URL for preview. */
export function useAuthedBlob(path: string | null) {
  const [state, setState] = useState<{ url: string; type: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let url: string | null = null;
    let cancelled = false;
    void fetch(buildUrl(path), { credentials: 'include', headers: { Authorization: `Bearer ${useAuthStore.getState().accessToken ?? ''}` } })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        setState({ url, type: blob.type });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return path ? state : null;
}
