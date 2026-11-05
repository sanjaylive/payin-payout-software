'use client';

import { cn } from '@pay2all/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { apiRequest } from '@/lib/api/client';
import { type AgentPlan, inr } from './api';

/** Agent plans and prices on the sign-up page (public endpoint). Everyone starts on Free. */
export function AgentPlansPreview({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['public', 'agent-plans'],
    queryFn: () => apiRequest<AgentPlan[]>('/v1/public/agent-plans', { auth: false }).then((r) => r.data),
    staleTime: 300_000,
  });
  if (!q.data?.length) return null;
  return (
    <section id="agent-plans" className={cn('rounded-lg border', className)}>
      <button type="button" className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Agent plans — start free, upgrade any time
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul className="divide-y border-t">
          {q.data.map((p) => (
            <li key={p.code} className="space-y-1 px-3 py-2.5 text-xs">
              <p className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{p.name}</span>
                <span className="tabular-nums">{Number(p.price_monthly) > 0 ? `${inr(p.price_monthly)}/month` : 'Free'}</span>
              </p>
              <p className="text-muted-foreground">
                {p.monthly_txn_limit === null ? 'Unlimited entries' : `${p.monthly_txn_limit.toLocaleString('en-IN')} entries a month`} · {p.staff_limit} {p.staff_limit === 1 ? 'login' : 'logins'}
                {Number(p.price_yearly) > 0 ? ` · ${inr(p.price_yearly)}/year` : ''}
              </p>
              {(p.drive_backup || p.branded_receipts || p.messaging) && (
                <p className="text-muted-foreground flex flex-wrap gap-x-3">
                  {p.drive_backup && (
                    <span className="inline-flex items-center gap-1">
                      <Check className="text-success size-3" aria-hidden /> Drive backup
                    </span>
                  )}
                  {p.branded_receipts && (
                    <span className="inline-flex items-center gap-1">
                      <Check className="text-success size-3" aria-hidden /> Your logo on receipts
                    </span>
                  )}
                  {p.messaging && (
                    <span className="inline-flex items-center gap-1">
                      <Check className="text-success size-3" aria-hidden /> SMS / WhatsApp receipts
                    </span>
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
