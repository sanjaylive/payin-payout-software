'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Badge } from '@pay2all/ui/components/ui/badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Globe, ImageUp, Loader2, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/features/funds/shared';
import { api, ApiError, apiUpload } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { assetUrl, type Brand } from '@/lib/brand/brand';
import { BRAND_KEY } from '@/lib/brand/brand-provider';

interface ResellerBrandState {
  configured: boolean;
  brand: {
    product_name: string;
    short_name: string;
    primary_color: string | null;
    support_email: string | null;
    support_phone: string | null;
    website_url: string | null;
    login_headline: string | null;
    login_subtext: string | null;
    footer_text: string | null;
    logos: ('LOGO' | 'LOGO_DARK' | 'ICON')[];
  } | null;
  domain: { name: string; verified: boolean; verified_at: string | null; dns: { type: 'TXT'; name: string; value: string } } | null;
  effective: Brand;
}

type Form = { product_name: string; short_name: string; primary_color: string; support_email: string; support_phone: string; website_url: string; login_headline: string; login_subtext: string; footer_text: string };
const KEY = ['reseller-brand'];
const KINDS = [
  { kind: 'LOGO', label: 'Logo', hint: 'Light backgrounds · PNG, SVG, WebP or JPEG · ≤ 1 MB' },
  { kind: 'LOGO_DARK', label: 'Logo for dark backgrounds', hint: 'Optional' },
  { kind: 'ICON', label: 'Icon', hint: 'Square, at least 32 × 32' },
] as const;
const ASSET_FIELD = { LOGO: 'logo', LOGO_DARK: 'logo_dark', ICON: 'icon' } as const;

/** Reseller / API partner: its own white-label brand and custom domain (docs/BRANDING.md §5). */
export function ResellerBranding() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<ResellerBrandState>('/v1/reseller/brand') });
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  return <Editor state={q.data} />;
}

function Editor({ state }: { state: ResellerBrandState }) {
  const qc = useQueryClient();
  const b = state.brand;
  const [f, setF] = useState<Form>({
    product_name: b?.product_name ?? '',
    short_name: b?.short_name ?? '',
    primary_color: b?.primary_color ?? '',
    support_email: b?.support_email ?? '',
    support_phone: b?.support_phone ?? '',
    website_url: b?.website_url ?? '',
    login_headline: b?.login_headline ?? '',
    login_subtext: b?.login_subtext ?? '',
    footer_text: b?.footer_text ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const file = useRef<Record<string, HTMLInputElement | null>>({});
  const set = (k: keyof Form, v: string) => setF((x) => ({ ...x, [k]: v }));
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: KEY });
    await qc.invalidateQueries({ queryKey: BRAND_KEY });
  };
  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    setErrors({});
    try {
      await fn();
      toast.success(done);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) setErrors(Object.fromEntries(err.details.map((d) => [d.path.split('.')[0]!, d.message])));
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const field = (k: keyof Form, label: string, props: Record<string, unknown> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`rb-${k}`}>{label}</Label>
      <Input id={`rb-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={Boolean(errors[k])} {...props} />
      {errors[k] && <p className="text-destructive text-xs">{errors[k]}</p>}
    </div>
  );
  const color = /^#[0-9a-fA-F]{6}$/.test(f.primary_color) ? f.primary_color : null;
  const cnameTarget = typeof window !== 'undefined' ? window.location.host : '';

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Your brand</CardTitle>
            <CardDescription>Your team, your merchants’ teams and your merchants’ customers (checkout, payment links and pages) see this instead of the platform brand. Empty fields use the platform’s.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {field('product_name', 'Product name', { placeholder: 'Acme Pay', maxLength: 60 })}
            {field('short_name', 'Short name', { placeholder: 'AcmePay', maxLength: 30 })}
            <div className="space-y-1.5">
              <Label htmlFor="rb-primary_color">Brand colour</Label>
              <div className="flex gap-2">
                <input type="color" aria-label="Pick a colour" value={color ?? '#2563eb'} onChange={(e) => set('primary_color', e.target.value)} className="h-9 w-12 cursor-pointer rounded-md border" />
                <Input id="rb-primary_color" value={f.primary_color} onChange={(e) => set('primary_color', e.target.value)} placeholder="#0e7490" className="font-mono" />
              </div>
              {errors.primary_color && <p className="text-destructive text-xs">{errors.primary_color}</p>}
            </div>
            {field('website_url', 'Website', { placeholder: 'https://acme.example.in' })}
            {field('support_email', 'Support email', { type: 'email' })}
            {field('support_phone', 'Support phone')}
            <div className="sm:col-span-2">{field('login_headline', 'Sign-in headline', { maxLength: 120 })}</div>
            <div className="sm:col-span-2">{field('login_subtext', 'Sign-in text', { maxLength: 300 })}</div>
            <div className="sm:col-span-2">{field('footer_text', 'Footer text', { maxLength: 200 })}</div>
            <div className="sm:col-span-2">
              <Button disabled={busy !== null || f.product_name.trim().length < 2 || f.short_name.trim().length < 2} onClick={() => void run('save', () => api.put('/v1/reseller/brand', f), 'Brand saved')}>
                {busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />} Save brand
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ImageUp className="size-4" /> Logos
            </CardTitle>
            <CardDescription>{state.configured ? 'Shown in the dashboard and on checkout.' : 'Save your brand name first.'}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            {KINDS.map(({ kind, label, hint }) => {
              const own = b?.logos.includes(kind);
              const url = own ? assetUrl(state.effective.assets[ASSET_FIELD[kind]]) : null;
              return (
                <div key={kind} className="flex flex-col gap-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">{label}</p>
                  <div className={`flex h-20 items-center justify-center rounded-md ${kind === 'LOGO_DARK' ? 'bg-slate-900' : 'bg-muted/50'}`}>
                    {url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- brand image served by the API
                      <img src={url} alt={label} className="max-h-16 max-w-full object-contain" />
                    ) : (
                      <span className="text-muted-foreground text-xs">Platform default</span>
                    )}
                  </div>
                  <p className="text-muted-foreground text-[11px]">{hint}</p>
                  <input
                    ref={(el) => {
                      file.current[kind] = el;
                    }}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"
                    className="hidden"
                    aria-label={`${label} file`}
                    onChange={(e) => {
                      const picked = e.target.files?.[0];
                      if (!picked) return;
                      const form = new FormData();
                      form.append('file', picked);
                      void run(kind, () => apiUpload(`/v1/reseller/brand/assets/${kind}`, form), `${label} updated`);
                      e.target.value = '';
                    }}
                  />
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" disabled={!state.configured || busy !== null} onClick={() => file.current[kind]?.click()}>
                      {busy === kind ? <Loader2 className="animate-spin" /> : null} Upload
                    </Button>
                    {own && (
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={busy !== null} aria-label={`Remove ${label}`} onClick={() => void run(`rm-${kind}`, () => api.post(`/v1/reseller/brand/assets/${kind}/remove`), `${label} removed`)}>
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4" /> Custom domain
            </CardTitle>
            <CardDescription>Serve sign-in, the dashboard and your merchants’ checkout from your own domain, e.g. pay.yourcompany.com.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!state.domain ? (
              <div className="flex flex-wrap gap-2">
                <Input aria-label="Your domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="pay.yourcompany.com" className="max-w-xs" />
                <Button disabled={!state.configured || busy !== null || domain.trim().length < 4} onClick={() => void run('domain', () => api.post('/v1/reseller/brand/domain', { domain: domain.trim() }), 'Domain added — now add the DNS records')}>
                  {busy === 'domain' && <Loader2 className="animate-spin" />} Add domain
                </Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{state.domain.name}</span>
                  {state.domain.verified ? (
                    <Badge className="gap-1 bg-emerald-600 text-white">
                      <CheckCircle2 className="size-3" /> Verified {state.domain.verified_at ? formatDateTime(state.domain.verified_at) : ''}
                    </Badge>
                  ) : (
                    <Badge variant="outline">Waiting for DNS</Badge>
                  )}
                </div>
                <ol className="space-y-3 text-sm">
                  <li className="space-y-1.5">
                    <p className="font-medium">1. Prove you own it — add this TXT record at your DNS provider:</p>
                    <div className="bg-muted/50 grid gap-1 rounded-lg border p-3 font-mono text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground w-12">Name</span>
                        <span className="min-w-0 flex-1 truncate">{state.domain.dns.name}</span>
                        <CopyButton value={state.domain.dns.name} label="Record name" />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground w-12">Value</span>
                        <span className="min-w-0 flex-1 truncate">{state.domain.dns.value}</span>
                        <CopyButton value={state.domain.dns.value} label="Record value" />
                      </div>
                    </div>
                  </li>
                  <li className="space-y-1.5">
                    <p className="font-medium">2. Point the domain at the platform — a CNAME record:</p>
                    <div className="bg-muted/50 flex items-center gap-2 rounded-lg border p-3 font-mono text-xs">
                      <span className="min-w-0 flex-1 truncate">
                        {state.domain.name} → {cnameTarget}
                      </span>
                      <CopyButton value={cnameTarget} label="CNAME target" />
                    </div>
                    <p className="text-muted-foreground text-xs">The platform team then issues the HTTPS certificate for your domain; contact support once the CNAME is in place.</p>
                  </li>
                </ol>
                <div className="flex flex-wrap gap-2">
                  {!state.domain.verified && (
                    <Button disabled={busy !== null} onClick={() => void run('verify', () => api.post('/v1/reseller/brand/domain/verify'), 'Domain verified')}>
                      {busy === 'verify' ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Check DNS now
                    </Button>
                  )}
                  <Button variant="outline" className="text-destructive" disabled={busy !== null} onClick={() => void run('rm-domain', () => api.post('/v1/reseller/brand/domain/remove'), 'Domain removed')}>
                    Remove domain
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Checkout preview</CardTitle>
          <CardDescription>What your merchants’ customers see.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-xl border">
            <div className="space-y-3 p-4 text-white" style={{ background: color ?? '#1d4ed8' }}>
              <p className="text-xs opacity-80">Paying</p>
              <p className="font-semibold">A merchant of yours</p>
              <p className="text-2xl font-semibold">₹2,499.00</p>
              <p className="text-[11px] opacity-80">Secured by {f.product_name || 'your brand'}</p>
            </div>
            <div className="space-y-2 p-4">
              <div className="bg-muted h-8 rounded-md" />
              <div className="h-9 rounded-md text-center text-sm leading-9 font-medium text-white" style={{ background: color ?? '#1d4ed8' }}>
                Pay ₹2,499.00
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
