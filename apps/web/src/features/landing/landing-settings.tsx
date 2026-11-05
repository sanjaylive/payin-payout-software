'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Label } from '@pay2all/ui/components/ui/label';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { cn } from '@pay2all/ui/lib/utils';
import type { LandingVariant } from '@pay2all/validation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Check, ExternalLink, Globe, Loader2, Save, Store } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { BRAND_KEY, useBrand } from '@/lib/brand/brand-provider';

const OPTIONS: {
  value: LandingVariant;
  title: string;
  audience: string;
  text: string;
  icon: typeof Store;
  gradient: string;
  points: string[];
}[] = [
  {
    value: 'PAYMENTS',
    title: 'Payin & Payout gateway',
    audience: 'For merchants, resellers and API partners',
    text: 'UPI, cards and net banking collections, instant IMPS/NEFT/UPI payouts, settlements and developer APIs.',
    icon: ArrowLeftRight,
    gradient: 'from-[#0b1d1a] via-[#0f3d34] to-[#c9a227]',
    points: ['Hero with live payment flow', 'Payin, payout & settlement features', 'Developer API section', 'Merchant sign-up CTA'],
  },
  {
    value: 'CSP',
    title: 'Merchant (CSP) payment record',
    audience: 'For customer service points, agents and retailers',
    text: 'A digital counter register for DMT, AEPS, cash deposit, bills and recharges — receipts, cash book, staff and backups.',
    icon: Store,
    gradient: 'from-[#1a0b2e] via-[#5b1d5e] to-[#f2795c]',
    points: ['Hero with digital receipt', 'Counter, customers & cash book', 'Plans (Free, Starter, Business)', 'Agent / CSP sign-up CTA'],
  },
];

/** Settings → Landing Page: which public page "/" shows. */
export function LandingSettings() {
  const brand = useBrand();
  const qc = useQueryClient();
  const router = useRouter();
  const current: LandingVariant = brand.landing_variant ?? 'PAYMENTS';
  const [choice, setChoice] = useState<LandingVariant>(current);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = choice !== current;

  async function save() {
    setSaving(true);
    try {
      await api.put('/v1/brand/landing', { landing_variant: choice, reason: reason.trim() });
      toast.success('Landing page switched — it’s live now');
      setReason('');
      await qc.invalidateQueries({ queryKey: BRAND_KEY });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div role="radiogroup" aria-label="Landing page" className="grid gap-4 lg:grid-cols-2">
        {OPTIONS.map((o) => {
          const selected = choice === o.value;
          const live = current === o.value;
          const Icon = o.icon;
          return (
            <Card
              key={o.value}
              role="radio"
              aria-checked={selected}
              tabIndex={0}
              onClick={() => setChoice(o.value)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  setChoice(o.value);
                }
              }}
              className={cn(
                'cursor-pointer gap-0 overflow-hidden pt-0 shadow-none transition-all outline-none',
                selected ? 'ring-primary ring-2' : 'hover:ring-primary/40 hover:ring-1',
                'focus-visible:ring-primary focus-visible:ring-2',
              )}
            >
              <div className={cn('relative h-36 bg-gradient-to-br p-5 text-white', o.gradient)}>
                <div className="flex items-start justify-between">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
                    <Icon className="size-5" />
                  </span>
                  <div className="flex gap-2">
                    {live && <span className="rounded-full bg-emerald-400/90 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-950">Live</span>}
                    {selected && (
                      <span className="flex size-6 items-center justify-center rounded-full bg-white text-black">
                        <Check className="size-3.5" />
                      </span>
                    )}
                  </div>
                </div>
                <p className="mt-6 text-lg font-semibold tracking-tight">{o.title}</p>
                <p className="text-xs text-white/75">{o.audience}</p>
              </div>
              <CardContent className="space-y-3 pt-4">
                <p className="text-muted-foreground text-sm">{o.text}</p>
                <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
                  {o.points.map((p) => (
                    <li key={p} className="flex items-center gap-2">
                      <Check className="text-primary size-3.5 shrink-0" /> {p}
                    </li>
                  ))}
                </ul>
                <a
                  href={`/?preview=${o.value.toLowerCase()}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-primary inline-flex items-center gap-1 text-sm font-medium hover:underline"
                >
                  Preview <ExternalLink className="size-3.5" />
                </a>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="size-4" /> Search engines & AI assistants
          </CardTitle>
          <CardDescription>
            The live landing page sets its own title, description, Open Graph tags and structured data (JSON-LD). <code>/robots.txt</code>, <code>/sitemap.xml</code> and <code>/llms.txt</code> follow this choice
            automatically; dashboards stay hidden from crawlers.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          {['/robots.txt', '/sitemap.xml', '/llms.txt'].map((p) => (
            <a key={p} href={p} target="_blank" rel="noreferrer" className="bg-muted hover:bg-muted/70 inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-mono text-xs">
              {p} <ExternalLink className="size-3" />
            </a>
          ))}
        </CardContent>
      </Card>

      {dirty && (
        <Card className="border-primary/40 shadow-none">
          <CardContent className="space-y-3 pt-6">
            <Label htmlFor="landing-reason">Reason (recorded in the audit log)</Label>
            <Textarea id="landing-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Launching the CSP counter product" maxLength={300} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setChoice(current)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={saving || reason.trim().length < 5}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Make it live
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
