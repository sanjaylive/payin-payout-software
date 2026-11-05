import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  BookUser,
  Check,
  CloudUpload,
  Fingerprint,
  HandCoins,
  Landmark,
  Lock,
  MessageCircle,
  Minus,
  Printer,
  Receipt,
  ReceiptIndianRupee,
  Smartphone,
  Sparkles,
  Users,
  Wallet,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import type { Brand } from '@/lib/brand/brand';
import { Faqs, LandingShell, SectionHead } from './shell';
import { CSP_FAQ } from './site';

export interface PublicPlan {
  code: 'FREE' | 'STARTER' | 'BUSINESS';
  name: string;
  description: string | null;
  price_monthly: string;
  price_yearly: string;
  monthly_txn_limit: number | null;
  staff_limit: number;
  drive_backup: boolean;
  branded_receipts: boolean;
  messaging: boolean;
}

/** docs/AGENTS.md §2 defaults, shown when the API can't be reached. */
export const FALLBACK_PLANS: PublicPlan[] = [
  { code: 'FREE', name: 'Free', description: 'For a new counter', price_monthly: '0.00', price_yearly: '0.00', monthly_txn_limit: 100, staff_limit: 1, drive_backup: false, branded_receipts: false, messaging: false },
  { code: 'STARTER', name: 'Starter', description: 'For a busy shop', price_monthly: '199.00', price_yearly: '1999.00', monthly_txn_limit: 2000, staff_limit: 3, drive_backup: true, branded_receipts: true, messaging: false },
  { code: 'BUSINESS', name: 'Business', description: 'For multi-staff centres', price_monthly: '499.00', price_yearly: '4999.00', monthly_txn_limit: null, staff_limit: 10, drive_backup: true, branded_receipts: true, messaging: true },
];

export async function fetchPlans(): Promise<PublicPlan[]> {
  const base = process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/v1/public/agent-plans`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(1500) });
    if (!res.ok) return FALLBACK_PLANS;
    const body = (await res.json()) as { data?: PublicPlan[] };
    return body.data?.length ? body.data : FALLBACK_PLANS;
  } catch {
    return FALLBACK_PLANS;
  }
}

const rupees = (v: string) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const NAV = [
  { href: '#services', label: 'Services' },
  { href: '#features', label: 'Features' },
  { href: '#how', label: 'How it works' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
];

function HeroVisual({ brand }: { brand: Brand }) {
  return (
    <div className="relative mx-auto w-full max-w-[520px] lg:mx-0" aria-hidden>
      <div className="absolute -inset-10 rounded-[40px] bg-[radial-gradient(closest-side,var(--l-mesh-2),transparent)] opacity-80 blur-2xl" />

      {/* Cash book */}
      <div className="l-card l-ring relative bg-[var(--l-surface)]/85 p-6 shadow-[0_40px_120px_-30px_rgb(0_0_0/0.8)]">
        <div className="flex items-center justify-between">
          <div>
            <p className="l-muted text-xs">Today’s cash book</p>
            <p className="l-display mt-1 text-2xl font-semibold">Sharma Digital Seva</p>
          </div>
          <span className="l-chip !text-[11px]">
            <span className="l-pulse size-1.5 rounded-full bg-[var(--l-accent)]" /> 42 entries
          </span>
        </div>
        <div className="mt-6 grid grid-cols-3 gap-3">
          {[
            { k: 'Cash in', v: '₹ 86,400', c: 'l-accent-2' },
            { k: 'Cash out', v: '₹ 51,200', c: 'l-accent' },
            { k: 'Earnings', v: '₹ 1,284', c: '' },
          ].map((s) => (
            <div key={s.k} className="rounded-2xl border border-[var(--l-line)] bg-white/[0.03] p-3">
              <p className="l-muted text-[11px]">{s.k}</p>
              <p className={`l-display mt-1 text-lg font-semibold tabular-nums ${s.c}`}>{s.v}</p>
            </div>
          ))}
        </div>
        <div className="mt-5 space-y-2">
          {[
            { t: 'Money transfer · Ramesh K.', m: 'to SBI ••4521', a: '₹ 10,000', f: '+₹50' },
            { t: 'AEPS withdrawal · Sunita D.', m: 'Aadhaar-enabled', a: '₹ 3,000', f: '+₹15' },
            { t: 'Electricity bill · Anil P.', m: 'MSEDCL', a: '₹ 1,460', f: '+₹10' },
          ].map((r) => (
            <div key={r.t} className="flex items-center gap-3 rounded-xl border border-[var(--l-line)] bg-white/[0.025] px-3 py-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--l-accent)]/15 text-[var(--l-accent)]">
                <Receipt className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.t}</p>
                <p className="l-muted truncate text-[11px]">{r.m}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold tabular-nums">{r.a}</p>
                <p className="l-accent-2 text-[11px] tabular-nums">{r.f}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Receipt */}
      <div className="l-float absolute -right-4 -bottom-14 hidden w-56 rotate-3 rounded-2xl bg-[#fffaf3] p-4 text-[#2a1a12] shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)] sm:block">
        <div className="flex items-center justify-between border-b border-dashed border-[#2a1a12]/25 pb-2">
          <p className="text-xs font-bold">RECEIPT #0428</p>
          <BadgeCheck className="size-4 text-emerald-600" />
        </div>
        <div className="space-y-1 py-2 text-[11px]">
          <p className="flex justify-between">
            <span>Money transfer</span>
            <span className="font-semibold">₹10,000</span>
          </p>
          <p className="flex justify-between">
            <span>Service charge</span>
            <span>₹50</span>
          </p>
          <p className="flex justify-between text-[#2a1a12]/60">
            <span>Beneficiary</span>
            <span>SBI ••4521</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5 rounded-lg bg-[#25d366]/15 px-2 py-1.5 text-[11px] font-semibold text-[#128c4a]">
          <MessageCircle className="size-3.5" /> Shared on WhatsApp
        </div>
        <p className="mt-2 text-center text-[9px] text-[#2a1a12]/50">via {brand.short_name}</p>
      </div>
    </div>
  );
}

function Hero({ brand }: { brand: Brand }) {
  return (
    <section className="l-grain relative isolate overflow-hidden">
      <div className="l-mesh" />
      <div className="l-grid" />
      <div className="relative mx-auto grid max-w-7xl items-center gap-20 px-4 pt-16 pb-28 sm:px-6 sm:pt-24 lg:grid-cols-[1.05fr_1fr] lg:pb-36">
        <div>
          <p className="l-chip l-rise">
            <Sparkles className="l-accent size-3.5" /> For CSP · Bank Mitra · AEPS agents · Retailers
          </p>
          <h1 className="l-display l-rise l-d1 mt-7 text-[2.75rem] leading-[1.02] font-semibold sm:text-6xl lg:text-7xl">
            Your counter,
            <br />
            <span className="l-serif l-grad-text pr-2">digitally</span> organised.
          </h1>
          <p className="l-muted l-rise l-d2 mt-7 max-w-xl text-lg leading-relaxed">
            {brand.product_name} is the payment record book for customer service points. Log every money transfer, AEPS withdrawal, deposit, bill and recharge in seconds — hand over a receipt, and always know your cash.
          </p>
          <div className="l-rise l-d3 mt-9 flex flex-wrap gap-3">
            <Link href="/signup?type=agent" className="l-btn l-btn-primary">
              Start free — no KYC <ArrowRight className="size-4" />
            </Link>
            <a href="#pricing" className="l-btn l-btn-ghost">
              See plans
            </a>
          </div>
          <p className="l-display l-rise l-d4 mt-10 text-xl">
            <span className="l-serif l-accent">“Hisaab saaf, bharosa pakka.”</span>
          </p>
          <p className="l-muted text-sm">Clean accounts. Customers who trust you.</p>
        </div>
        <HeroVisual brand={brand} />
      </div>
    </section>
  );
}

function Services() {
  const items = [
    { icon: Banknote, t: 'Money transfer', d: 'DMT to any bank or UPI' },
    { icon: Fingerprint, t: 'AEPS withdrawal', d: 'Aadhaar-enabled cash out' },
    { icon: Landmark, t: 'Cash deposit', d: 'Into the customer’s account' },
    { icon: ReceiptIndianRupee, t: 'Bill payment', d: 'Electricity, water, gas, FASTag' },
    { icon: Smartphone, t: 'Recharge', d: 'Mobile & DTH' },
    { icon: HandCoins, t: 'Any other service', d: 'With your own charge' },
  ];
  return (
    <section id="services" className="scroll-mt-20 border-y border-[var(--l-line)] bg-white/[0.015]">
      <div className="mx-auto grid max-w-7xl grid-cols-2 divide-[var(--l-line)] px-4 sm:px-6 md:grid-cols-3 lg:grid-cols-6 lg:divide-x">
        {items.map((s) => (
          <div key={s.t} className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <s.icon className="l-accent size-6" />
            <p className="text-sm font-semibold">{s.t}</p>
            <p className="l-muted text-xs">{s.d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <SectionHead eyebrow="Features" title="Everything your counter needs —" accent="nothing it doesn’t." text="Built with CSP owners: fast at the counter, simple for staff, and safe for your customers’ details." />
      <div className="mt-16 grid gap-5 lg:grid-cols-3 lg:grid-rows-2">
        <article className="l-card l-card-hover p-8 lg:row-span-2">
          <span className="l-icon">
            <Printer className="size-5" />
          </span>
          <h3 className="l-display mt-6 text-2xl font-semibold">Receipts in one tap</h3>
          <p className="l-muted mt-3 leading-relaxed">Every entry gets a numbered receipt with your shop name. Print it on any printer, or share a secure link on WhatsApp. On Business, receipts go out automatically by SMS or WhatsApp.</p>
          <div className="mt-8 space-y-3">
            {['Numbered, tamper-proof receipts', 'Your logo & footer (Starter and up)', 'Secure link — no app needed for customers', 'Reprint any old receipt'].map((t) => (
              <p key={t} className="flex items-center gap-2.5 text-sm">
                <Check className="l-accent-2 size-4 shrink-0" /> {t}
              </p>
            ))}
          </div>
        </article>
        {[
          { icon: BookUser, t: 'Customer & beneficiary book', d: 'Save a customer once with their bank accounts and UPI IDs. Next visit, pick and go.' },
          { icon: Wallet, t: 'Live cash book', d: 'Cash in, cash out and your service-charge earnings — for today, this week, any day.' },
          { icon: Users, t: 'Staff logins', d: 'Give counter staff their own login. They record entries; you control settings and reports.' },
          { icon: CloudUpload, t: 'Google Drive backup', d: 'Your data, in your own Drive. Export to CSV whenever you need it.' },
        ].map((f) => (
          <article key={f.t} className="l-card l-card-hover p-7">
            <span className="l-icon">
              <f.icon className="size-5" />
            </span>
            <h3 className="mt-5 text-lg font-semibold">{f.t}</h3>
            <p className="l-muted mt-2 text-sm leading-relaxed">{f.d}</p>
          </article>
        ))}
      </div>
      <div className="mt-5 grid gap-5 md:grid-cols-3">
        {[
          { icon: Lock, t: 'Encrypted customer IDs', d: 'Aadhaar, PAN and account numbers are encrypted; lists show only the last 4 digits.' },
          { icon: Smartphone, t: 'Web + Android app', d: 'Use a computer at the counter or the app on your phone — one account, always in sync.' },
          { icon: Zap, t: 'Ten-second entries', d: 'Designed for queues: saved customers and beneficiaries mean less typing at the counter.' },
        ].map((f) => (
          <div key={f.t} className="flex gap-4 rounded-[var(--l-radius)] border border-[var(--l-line)] p-6">
            <f.icon className="l-accent-2 mt-0.5 size-5 shrink-0" />
            <div>
              <p className="font-semibold">{f.t}</p>
              <p className="l-muted mt-1 text-sm leading-relaxed">{f.d}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function How() {
  const steps = [
    { n: '01', t: 'Serve as usual', d: 'Complete the transfer, AEPS withdrawal or bill on your bank CSP portal or device.' },
    { n: '02', t: 'Record in seconds', d: 'Pick the customer, enter the amount and your charge. The cash book updates instantly.' },
    { n: '03', t: 'Hand the receipt', d: 'Print or WhatsApp it. Your customer leaves with proof — and comes back to you.' },
  ];
  return (
    <section id="how" className="scroll-mt-20 border-y border-[var(--l-line)] bg-[var(--l-surface)]/40 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHead eyebrow="How it works" title="Fits right into" accent="your counter." />
        <ol className="mt-16 grid gap-5 md:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n} className="l-card l-card-hover relative overflow-hidden p-8">
              <span className="l-display l-grad-text absolute -top-4 -right-1 text-8xl font-bold opacity-25 select-none">{s.n}</span>
              <h3 className="l-display relative text-xl font-semibold">{s.t}</h3>
              <p className="l-muted relative mt-3 text-sm leading-relaxed">{s.d}</p>
            </li>
          ))}
        </ol>
        <p className="l-muted mx-auto mt-10 max-w-2xl text-center text-xs leading-relaxed">
          {`This is a record-keeping app: it does not move money or connect to your bank portal. Transactions are completed by you on your existing bank CSP portal, AEPS device or UPI app.`}
        </p>
      </div>
    </section>
  );
}

function Pricing({ plans }: { plans: PublicPlan[] }) {
  return (
    <section id="pricing" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <SectionHead eyebrow="Pricing" title="Start free." accent="Grow when you’re ready." text="No setup fee. No KYC to start. Upgrade or downgrade anytime — your data always stays." />
      <div className="mt-16 grid gap-5 lg:grid-cols-3">
        {plans.map((p) => {
          const featured = p.code === 'STARTER';
          const free = Number(p.price_monthly) === 0;
          const rows = [
            { on: true, t: p.monthly_txn_limit === null ? 'Unlimited entries a month' : `${p.monthly_txn_limit.toLocaleString('en-IN')} entries a month` },
            { on: true, t: `${p.staff_limit} ${p.staff_limit === 1 ? 'login' : 'logins'} (owner included)` },
            { on: true, t: 'Receipts, customers, cash book, reports' },
            { on: true, t: 'Share receipts on WhatsApp' },
            { on: p.drive_backup, t: 'Google Drive backup' },
            { on: p.branded_receipts, t: 'Your logo & footer on receipts' },
            { on: p.messaging, t: 'Automatic SMS / WhatsApp receipts' },
          ];
          return (
            <article key={p.code} className={`l-card flex flex-col p-8 ${featured ? 'l-ring bg-[var(--l-surface-2)]/80 lg:-translate-y-3' : ''}`}>
              <div className="flex items-center justify-between">
                <h3 className="l-display text-xl font-semibold">{p.name}</h3>
                {featured && <span className="rounded-full bg-[var(--l-accent)] px-3 py-1 text-[11px] font-bold text-[var(--l-accent-ink)]">Most popular</span>}
              </div>
              {p.description && <p className="l-muted mt-1 text-sm">{p.description}</p>}
              <p className="mt-7 flex items-baseline gap-1.5">
                <span className="l-display text-5xl font-semibold">{rupees(p.price_monthly)}</span>
                <span className="l-muted text-sm">{free ? 'forever' : '/ month'}</span>
              </p>
              <p className="l-muted mt-1 h-5 text-xs">{!free && `or ${rupees(p.price_yearly)} / year`}</p>
              <ul className="mt-7 flex-1 space-y-3 text-sm">
                {rows.map((r) => (
                  <li key={r.t} className={`flex items-start gap-2.5 ${r.on ? '' : 'l-muted opacity-60'}`}>
                    {r.on ? <Check className="l-accent-2 mt-0.5 size-4 shrink-0" /> : <Minus className="mt-0.5 size-4 shrink-0" />}
                    {r.t}
                  </li>
                ))}
              </ul>
              <Link href="/signup?type=agent" className={`l-btn mt-8 w-full ${featured ? 'l-btn-primary' : 'l-btn-ghost'}`}>
                {free ? 'Start free' : `Choose ${p.name}`}
              </Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 sm:pb-32">
      <div className="l-card l-ring l-grain relative overflow-hidden px-6 py-16 text-center sm:px-16 sm:py-24">
        <div className="l-mesh opacity-80" />
        <div className="relative">
          <h2 className="l-display mx-auto max-w-3xl text-4xl leading-[1.05] font-semibold sm:text-6xl">
            Close every day with <span className="l-serif l-grad-text">perfect hisaab.</span>
          </h2>
          <p className="l-muted mx-auto mt-6 max-w-xl text-lg">Set up your shop in two minutes. Your first 100 entries every month are free, forever.</p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link href="/signup?type=agent" className="l-btn l-btn-primary">
              Create my counter <ArrowRight className="size-4" />
            </Link>
            <Link href="/login" className="l-btn l-btn-ghost">
              I already have an account
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CspLanding({ brand, plans, jsonLd, nonce, preview }: { brand: Brand; plans: PublicPlan[]; jsonLd: object; nonce?: string; preview?: boolean }) {
  return (
    <LandingShell
      brand={brand}
      variant="CSP"
      nav={NAV}
      signupHref="/signup?type=agent"
      jsonLd={jsonLd}
      nonce={nonce}
      preview={preview}
      footerColumns={[
        { title: 'Product', links: [{ href: '#services', label: 'Services' }, { href: '#features', label: 'Features' }, { href: '#pricing', label: 'Pricing' }, { href: '#faq', label: 'FAQ' }] },
        { title: 'Get started', links: [{ href: '/signup?type=agent', label: 'Create free account' }, { href: '/login', label: 'Sign in' }, { href: '#how', label: 'How it works' }] },
        { title: 'Resources', links: [{ href: '/llms.txt', label: 'llms.txt' }, { href: '/sitemap.xml', label: 'Sitemap' }] },
      ]}
    >
      <Hero brand={brand} />
      <Services />
      <Features />
      <How />
      <Pricing plans={plans} />
      <section id="faq" className="mx-auto max-w-7xl scroll-mt-20 px-4 pb-24 sm:px-6 sm:pb-32">
        <SectionHead eyebrow="FAQ" title="Good questions," accent="straight answers." />
        <div className="mt-14">
          <Faqs items={CSP_FAQ} />
        </div>
      </section>
      <FinalCta />
    </LandingShell>
  );
}
