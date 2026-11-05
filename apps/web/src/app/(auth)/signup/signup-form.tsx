'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@pay2all/ui/components/ui/button';
import { Checkbox } from '@pay2all/ui/components/ui/checkbox';
import { cn } from '@pay2all/ui/lib/utils';
import { signupFormSchema } from '@pay2all/validation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BadgeCheck, Building2, CloudUpload, Eye, EyeOff, Loader2, Mail, ReceiptText, RefreshCw, ShieldCheck, Sparkles, Store, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { AuthCard } from '@/components/auth/auth-card';
import { FormError } from '@/components/auth/form-error';
import { OtpInput } from '@/components/auth/otp-input';
import { FormField } from '@/components/common/form-field';
import { FullPageSpinner } from '@/components/common/full-page-spinner';
import { api, ApiError, apiRequest } from '@/lib/api/client';
import type { SessionTokens } from '@/lib/api/types';
import { useAuthStore } from '@/lib/auth/store';
import { useBrand } from '@/lib/brand/brand-provider';
import { AgentPlansPreview } from '@/features/agents/plans-preview';

type FormValues = z.input<typeof signupFormSchema>;
interface Started {
  signup_id: string;
  email_masked: string;
  expires_in: number;
  resend_after: number;
  /** Client clock when this code was sent (for the resend countdown). */
  sent_at?: number;
}

/** 0–4: length first, then variety. The server's policy (12+ characters, not your email or mobile) is what counts. */
function strength(pw: string): number {
  if (pw.length < 12) return pw.length ? 1 : 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return Math.min(4, 2 + (kinds >= 3 ? 1 : 0) + (pw.length >= 16 ? 1 : 0));
}
const stamp = (s: Started): Started => ({ ...s, sent_at: Date.now() });

const STRENGTH = ['', 'Too short', 'Fair', 'Strong', 'Very strong'];

function PasswordMeter({ value }: { value: string }) {
  const s = strength(value);
  if (!value) return null;
  return (
    <div className="space-y-1" aria-live="polite">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn('h-1 flex-1 rounded-full transition-colors', i <= s ? (s === 1 ? 'bg-destructive' : s === 2 ? 'bg-warning' : 'bg-success') : 'bg-muted')} />
        ))}
      </div>
      <p className="text-muted-foreground text-xs">{STRENGTH[s]}{s === 1 && ' — use at least 12 characters'}</p>
    </div>
  );
}

const PERKS = [
  { icon: Building2, text: 'Payins by UPI, cards and net banking; payouts by IMPS, NEFT and RTGS' },
  { icon: ShieldCheck, text: 'Your documents are encrypted and seen only by our compliance team' },
  { icon: Sparkles, text: 'Try everything in test mode while we review your business' },
];

const AGENT_PERKS = [
  { icon: ReceiptText, text: 'Record transfers, withdrawals, deposits and bills with a printable receipt for every customer' },
  { icon: Users, text: 'Save customers and beneficiaries; find them by mobile number next time' },
  { icon: CloudUpload, text: 'Daily totals, reports and CSV; Google Drive backup on paid plans' },
];

type AccountType = 'MERCHANT' | 'AGENT';

const ACCOUNT_TYPES: { value: AccountType; title: string; text: string; icon: typeof Store }[] = [
  { value: 'MERCHANT', title: 'Merchant', text: 'Collect payments', icon: Building2 },
  { value: 'AGENT', title: 'Agent / CSP', text: 'Record cash & transfers', icon: Store },
];

export function SignupForm() {
  const brand = useBrand();
  const router = useRouter();
  const params = useSearchParams();
  const ref = params.get('ref')?.trim().toLowerCase() || undefined;
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const [error, setError] = useState<unknown>(null);
  const [started, setStarted] = useState<Started | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [accountType, setAccountType] = useState<AccountType>(params.get('type')?.toLowerCase() === 'agent' ? 'AGENT' : 'MERCHANT');
  const agent = accountType === 'AGENT';

  const info = useQuery({
    queryKey: ['signup-info', ref ?? ''],
    queryFn: () => apiRequest<{ enabled: boolean; referrer: { name: string } | null }>('/v1/signup', { auth: false, query: ref ? { ref } : undefined }).then((r) => r.data),
    staleTime: 300_000,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(signupFormSchema),
    defaultValues: { name: '', business_name: '', email: '', mobile: '', password: '', confirm: '', referral_code: ref ?? '', accept_terms: false },
  });
  const { register, control, formState } = form;
  const password = useWatch({ control, name: 'password' });

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const code = v.referral_code.trim();
      const body = { name: v.name, business_name: v.business_name, email: v.email, mobile: v.mobile, password: v.password, accept_terms: true, account_type: accountType, ...(code ? { referral_code: code } : {}) };
      setStarted(stamp(await api.post<Started>('/v1/signup', body, { auth: false })));
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) {
        for (const d of e.details) form.setError(d.path as keyof FormValues, { message: d.message });
      }
      setError(e);
    }
  });

  if (info.isPending) return <FullPageSpinner />;
  if (info.data && !info.data.enabled) {
    return (
      <AuthCard title="Sign-up is by invitation" description={`New ${brand.short_name} accounts are opened by our team.`} footer={<Link href="/login" className="text-primary font-medium hover:underline">Back to sign in</Link>}>
        <p className="text-muted-foreground text-sm">Write to us{brand.support_email ? <> at <a className="text-foreground font-medium hover:underline" href={`mailto:${brand.support_email}`}>{brand.support_email}</a></> : ''} and we&apos;ll get you set up.</p>
      </AuthCard>
    );
  }

  if (started) {
    return (
      <VerifyStep
        started={started}
        onBack={() => setStarted(null)}
        onResent={(s) => setStarted(stamp(s))}
        onVerified={(tokens) => {
          setAccessToken(tokens.access_token!);
          toast.success('Email verified. Your account is ready');
          router.replace(tokens.status === 'MFA_ENROLLMENT_REQUIRED' ? '/setup-mfa' : agent ? '/agent' : '/onboarding');
        }}
      />
    );
  }

  const referrer = info.data?.referrer;
  return (
    <AuthCard
      title="Create your account"
      description={agent ? `Run your counter on ${brand.short_name}: customers, receipts and daily totals. Free to start.` : `Start accepting payments with ${brand.short_name}. It takes about two minutes.`}
      footer={<p>Already have an account? <Link href="/login" className="text-primary font-medium hover:underline">Sign in</Link></p>}
    >
      {referrer && (
        <div className="bg-primary/5 border-primary/20 mb-5 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <BadgeCheck className="text-primary size-4 shrink-0" /> Referred by <span className="font-medium">{referrer.name}</span>
        </div>
      )}
      <div role="radiogroup" aria-label="Account type" className="mb-5 grid grid-cols-2 gap-2">
        {ACCOUNT_TYPES.map((t) => {
          const on = accountType === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setAccountType(t.value)}
              className={cn('flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors', on ? 'border-primary bg-primary/5 ring-primary ring-1' : 'hover:border-primary/50')}
            >
              <t.icon className={cn('mt-0.5 size-4 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
              <span>
                <span className="block text-sm font-medium">{t.title}</span>
                <span className="text-muted-foreground block text-xs">{t.text}</span>
              </span>
            </button>
          );
        })}
      </div>
      <FormError error={error} />
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Your full name" autoComplete="name" autoFocus error={formState.errors.name?.message} {...register('name')} />
          <FormField label={agent ? 'Shop name' : 'Business name'} autoComplete="organization" error={formState.errors.business_name?.message} {...register('business_name')} />
        </div>
        <FormField label={agent ? 'Email' : 'Work email'} type="email" autoComplete="email" hint="We'll send a verification code here" error={formState.errors.email?.message} {...register('email')} />
        <FormField label="Mobile number" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="98765 43210" error={formState.errors.mobile?.message} {...register('mobile')} />
        <div className="space-y-2">
          <div className="relative">
            <FormField label="Password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" error={formState.errors.password?.message} {...register('password')} />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground absolute top-[30px] right-2 rounded p-1"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <PasswordMeter value={password} />
        </div>
        <FormField label="Confirm password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" error={formState.errors.confirm?.message} {...register('confirm')} />
        {!ref && (
          <FormField label="Referral code (optional)" autoComplete="off" placeholder="From your partner, if you have one" error={formState.errors.referral_code?.message} {...register('referral_code')} />
        )}
        <Controller
          control={control}
          name="accept_terms"
          render={({ field }) => (
            <div className="space-y-1">
              <label className="flex items-start gap-2.5 text-sm leading-5">
                <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} className="mt-0.5" aria-invalid={Boolean(formState.errors.accept_terms)} />
                <span className="text-muted-foreground">
                  I agree to the {brand.short_name} terms of service and privacy policy, and confirm I&apos;m authorised to open an account for this {agent ? 'shop' : 'business'}.
                </span>
              </label>
              {formState.errors.accept_terms && <p className="text-destructive text-xs">{formState.errors.accept_terms.message}</p>}
            </div>
          )}
        />
        <Button type="submit" size="lg" className="w-full" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? <Loader2 className="animate-spin" /> : <ArrowRight />} {agent ? 'Create agent account' : 'Create account'}
        </Button>
      </form>
      {agent && <AgentPlansPreview className="mt-8" />}
      <ul className="mt-8 space-y-2.5 border-t pt-6">
        {(agent ? AGENT_PERKS : PERKS).map(({ icon: Icon, text }) => (
          <li key={text} className="text-muted-foreground flex items-start gap-2.5 text-xs leading-5">
            <Icon className="text-primary mt-0.5 size-4 shrink-0" /> {text}
          </li>
        ))}
      </ul>
    </AuthCard>
  );
}

function VerifyStep({ started, onBack, onResent, onVerified }: { started: Started; onBack: () => void; onResent: (s: Started) => void; onVerified: (t: SessionTokens) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const wait = Math.max(0, Math.ceil(started.resend_after - (now - (started.sent_at ?? now)) / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function verify(value = code) {
    if (value.length !== 6 || busy) return;
    setError(null);
    setBusy(true);
    try {
      onVerified(await api.post<SessionTokens>('/v1/signup/verify', { signup_id: started.signup_id, code: value }, { auth: false }));
    } catch (e) {
      setError(e);
      setCode('');
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    setResending(true);
    try {
      onResent(await api.post<Started>('/v1/signup/resend', { signup_id: started.signup_id }, { auth: false }));
      toast.success('A new code is on its way');
    } catch (e) {
      setError(e);
    } finally {
      setResending(false);
    }
  }

  const expired = error instanceof ApiError && error.status === 404;
  return (
    <AuthCard
      title="Check your email"
      description={
        <>
          We sent a 6-digit code to <span className="text-foreground font-medium">{started.email_masked}</span>. It expires in {Math.round(started.expires_in / 60)} minutes.
        </>
      }
      footer={
        <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5">
          <ArrowLeft className="size-4" /> Change details
        </button>
      }
    >
      <div className="bg-primary/10 text-primary mb-6 flex size-12 items-center justify-center rounded-full">
        <Mail className="size-6" />
      </div>
      <FormError error={error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
        className="space-y-5"
      >
        <OtpInput value={code} onChange={setCode} onComplete={(v) => void verify(v)} disabled={busy || expired} invalid={Boolean(error) && !expired} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || code.length !== 6 || expired}>
          {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify and continue
        </Button>
      </form>
      <div className="text-muted-foreground mt-5 text-center text-sm">
        {expired ? (
          <button type="button" className="text-primary font-medium hover:underline" onClick={onBack}>Start again</button>
        ) : wait > 0 ? (
          <span>Didn&apos;t get it? Resend in {wait}s</span>
        ) : (
          <button type="button" className="text-primary inline-flex items-center gap-1.5 font-medium hover:underline disabled:opacity-60" onClick={() => void resend()} disabled={resending}>
            {resending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Resend code
          </button>
        )}
        <p className="mt-2 text-xs">Check your spam folder too. Never share this code with anyone.</p>
      </div>
    </AuthCard>
  );
}
