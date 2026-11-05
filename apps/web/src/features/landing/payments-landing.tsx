import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  BookOpenCheck,
  Building2,
  Code2,
  Fingerprint,
  GitBranch,
  Handshake,
  KeyRound,
  Link2,
  Lock,
  QrCode,
  Radar,
  Repeat,
  ShieldCheck,
  Sparkles,
  Store,
  Webhook,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import type { Brand } from '@/lib/brand/brand';
import { Faqs, LandingShell, SectionHead } from './shell';
import { PAYMENTS_FAQ } from './site';

const RAILS = ['UPI Intent', 'UPI Collect', 'Dynamic QR', 'Static QR', 'RuPay', 'Visa', 'Mastercard', 'Net banking', 'IMPS', 'NEFT', 'RTGS', 'UPI Payouts', 'WooCommerce', 'OpenCart', 'PHP SDK', 'checkout.js'];

const NAV = [
  { href: '#products', label: 'Products' },
  { href: '#how', label: 'How it works' },
  { href: '#developers', label: 'Developers' },
  { href: '#security', label: 'Security' },
  { href: '#faq', label: 'FAQ' },
];

/** Illustrative rows in the hero dashboard (not real data). */
const SAMPLE_ROWS = [
  { icon: ArrowDownLeft, title: 'UPI · Asha Rao', meta: 'pay_01JC8Z…  ·  2 s ago', amount: '+ ₹2,499.00', tone: 'in' },
  { icon: ArrowUpRight, title: 'IMPS payout · ABC Vendor', meta: 'pout_01JC8Z…  ·  UTR 4281…', amount: '− ₹15,000.00', tone: 'out' },
  { icon: ArrowDownLeft, title: 'Card · Rohan Mehta', meta: 'pay_01JC90…  ·  1 min ago', amount: '+ ₹8,750.00', tone: 'in' },
  { icon: Repeat, title: 'Settlement · HDFC ••7890', meta: 'T+1  ·  scheduled', amount: '₹1,24,380.00', tone: 'neutral' },
] as const;

const BARS = [38, 52, 44, 66, 58, 74, 62, 88, 70, 96, 82, 100];

function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[560px] lg:mx-0" aria-hidden>
      <div className="absolute -inset-8 rounded-[40px] bg-[radial-gradient(closest-side,var(--l-mesh-2),transparent)] opacity-70 blur-2xl" />
      <div className="l-card l-ring relative overflow-hidden bg-[var(--l-surface)]/80 p-5 shadow-[0_40px_120px_-30px_rgb(0_0_0/0.8)] sm:p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="l-muted text-xs">Collected today</p>
            <p className="l-display mt-1 text-3xl font-semibold sm:text-4xl">₹ 4,82,915<span className="l-muted text-xl">.40</span></p>
          </div>
          <span className="l-chip !text-[11px]">
            <span className="l-pulse size-1.5 rounded-full bg-[var(--l-accent-2)]" /> Live
          </span>
        </div>
        <div className="mt-6 flex h-28 items-end gap-1.5">
          {BARS.map((h, i) => (
            <div key={i} className="flex-1 rounded-t-md bg-gradient-to-t from-[var(--l-accent-2)]/20 to-[var(--l-accent-2)]/80" style={{ height: `${h}%`, opacity: 0.45 + i / 22 }} />
          ))}
        </div>
        <div className="mt-6 space-y-2">
          {SAMPLE_ROWS.map((r) => (
            <div key={r.title} className="flex items-center gap-3 rounded-xl border border-[var(--l-line)] bg-white/[0.025] px-3 py-2.5">
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${r.tone === 'in' ? 'bg-[var(--l-accent-2)]/15 text-[var(--l-accent-2)]' : r.tone === 'out' ? 'bg-[var(--l-accent)]/15 text-[var(--l-accent)]' : 'bg-white/10 text-white/80'}`}
              >
                <r.icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.title}</p>
                <p className="l-muted truncate font-mono text-[11px]">{r.meta}</p>
              </div>
              <p className={`text-sm font-semibold tabular-nums ${r.tone === 'in' ? 'l-accent-2' : r.tone === 'out' ? 'l-accent' : ''}`}>{r.amount}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="l-card l-float absolute -top-6 -right-3 hidden w-52 bg-[var(--l-surface-2)]/90 p-4 shadow-2xl sm:block">
        <div className="flex items-center gap-2 text-xs font-medium">
          <BadgeCheck className="l-accent-2 size-4" /> Payout successful
        </div>
        <p className="l-display mt-2 text-2xl font-semibold">₹ 15,000</p>
        <p className="l-muted mt-1 font-mono text-[11px]">IMPS · 6.2 s end-to-end</p>
      </div>
      <div className="l-card l-float-slow absolute -bottom-8 -left-6 hidden w-48 bg-[var(--l-surface-2)]/90 p-4 shadow-2xl sm:block">
        <div className="flex items-center gap-3">
          <span className="l-icon !size-10">
            <QrCode className="size-5" />
          </span>
          <div>
            <p className="text-xs font-medium">UPI QR</p>
            <p className="l-muted text-[11px]">Scan · Pay · Done</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero({ brand }: { brand: Brand }) {
  return (
    <section className="l-grain relative isolate overflow-hidden">
      <div className="l-mesh" />
      <div className="l-grid" />
      <div className="relative mx-auto grid max-w-7xl items-center gap-16 px-4 pt-16 pb-24 sm:px-6 sm:pt-24 lg:grid-cols-[1.05fr_1fr] lg:pb-32">
        <div>
          <p className="l-chip l-rise">
            <Sparkles className="l-accent size-3.5" /> Payin · Payout · Settlements — one platform
          </p>
          <h1 className="l-display l-rise l-d1 mt-7 text-[2.75rem] leading-[1.02] font-semibold sm:text-6xl lg:text-7xl">
            Collect every rupee.
            <br />
            <span className="l-serif l-grad-text pr-2">Pay out</span> in seconds.
          </h1>
          <p className="l-muted l-rise l-d2 mt-7 max-w-xl text-lg leading-relaxed">
            {brand.product_name} gives Indian businesses UPI, cards and net banking collections, instant IMPS / NEFT / RTGS / UPI payouts and automated settlements — all on one double-entry ledger with developer-first APIs.
          </p>
          <div className="l-rise l-d3 mt-9 flex flex-wrap gap-3">
            <Link href="/signup" className="l-btn l-btn-primary">
              Start accepting payments <ArrowRight className="size-4" />
            </Link>
            <Link href="/docs" className="l-btn l-btn-ghost">
              <Code2 className="size-4" /> Read the API docs
            </Link>
          </div>
          <ul className="l-muted l-rise l-d4 mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {['Double-entry ledger', 'Idempotent APIs', 'HMAC-signed webhooks', 'Smart routing'].map((t) => (
              <li key={t} className="flex items-center gap-2">
                <BadgeCheck className="l-accent size-4" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}

function Rails() {
  return (
    <section aria-label="Supported payment methods and integrations" className="border-y border-[var(--l-line)] bg-white/[0.015] py-6">
      <div className="l-marquee-mask overflow-hidden">
        <div className="l-marquee gap-3">
          {[...RAILS, ...RAILS].map((r, i) => (
            <span key={i} className="l-muted mx-1.5 rounded-full border border-[var(--l-line)] px-5 py-2 text-sm font-medium whitespace-nowrap" aria-hidden={i >= RAILS.length}>
              {r}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Products() {
  const small = [
    { icon: Link2, title: 'Payment links & pages', text: 'Share a link on WhatsApp or SMS, or publish a branded page — no website needed.' },
    { icon: QrCode, title: 'Static UPI QR', text: 'One QR for your counter. Every scan lands on your ledger with a webhook.' },
    { icon: Repeat, title: 'Settlements', text: 'Automatic settlement to your bank, with statements, invoices and GST-ready reports.' },
    { icon: GitBranch, title: 'Smart routing', text: 'Route across providers by success rate, cost and health — with automatic failover.' },
    { icon: BookOpenCheck, title: 'Double-entry ledger', text: 'Every rupee posted twice. Balances you can audit, reconcile and trust.' },
    { icon: Radar, title: 'Risk & disputes', text: 'Velocity and amount rules, review queues, refunds and chargeback handling.' },
  ];
  return (
    <section id="products" className="relative mx-auto max-w-7xl scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <SectionHead eyebrow="Products" title="Everything money needs," accent="in one place." text="From the first UPI collection to the last vendor payout — one dashboard, one balance, one API." />
      <div className="mt-16 grid gap-5 lg:grid-cols-2">
        <article className="l-card l-card-hover overflow-hidden p-8">
          <span className="l-icon">
            <ArrowDownLeft className="size-5" />
          </span>
          <h3 className="l-display mt-6 text-2xl font-semibold">Payin — collect from anyone</h3>
          <p className="l-muted mt-3 leading-relaxed">UPI intent, collect and dynamic QR, cards and net banking on a fast hosted checkout — or embed it with checkout.js. Refunds in a click.</p>
          <div className="mt-7 flex flex-wrap gap-2">
            {['UPI', 'Cards', 'Net banking', 'Hosted checkout', 'Refunds'].map((t) => (
              <span key={t} className="l-chip">
                {t}
              </span>
            ))}
          </div>
        </article>
        <article className="l-card l-card-hover overflow-hidden p-8">
          <span className="l-icon">
            <ArrowUpRight className="size-5" />
          </span>
          <h3 className="l-display mt-6 text-2xl font-semibold">Payout — pay anyone, instantly</h3>
          <p className="l-muted mt-3 leading-relaxed">Send to any bank account or UPI ID over IMPS, NEFT, RTGS or UPI. Upload a CSV for bulk payouts, add approvals, and track every UTR.</p>
          <div className="mt-7 flex flex-wrap gap-2">
            {['IMPS', 'NEFT', 'RTGS', 'UPI', 'Bulk CSV', 'Approvals'].map((t) => (
              <span key={t} className="l-chip">
                {t}
              </span>
            ))}
          </div>
        </article>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {small.map((f) => (
          <article key={f.title} className="l-card l-card-hover p-7">
            <span className="l-icon">
              <f.icon className="size-5" />
            </span>
            <h3 className="mt-5 text-lg font-semibold">{f.title}</h3>
            <p className="l-muted mt-2 text-sm leading-relaxed">{f.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function How() {
  const steps = [
    { n: '01', icon: Building2, title: 'Sign up & verify', text: 'Create your account, complete online KYB with your business documents and bank account.' },
    { n: '02', icon: KeyRound, title: 'Integrate in minutes', text: 'Use a plugin, payment links or the REST API with sandbox keys — go live with a switch.' },
    { n: '03', icon: Zap, title: 'Collect & pay out', text: 'Money lands on your ledger in real time. Pay vendors, refund customers, settle to your bank.' },
  ];
  return (
    <section id="how" className="relative scroll-mt-20 border-y border-[var(--l-line)] bg-[var(--l-surface)]/40 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHead eyebrow="How it works" title="Live in three steps," accent="not three months." />
        <div className="relative mt-16 grid gap-6 md:grid-cols-3">
          <svg className="pointer-events-none absolute top-14 left-[16%] hidden h-2 w-[68%] md:block" viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden>
            <line x1="0" y1="1" x2="100" y2="1" stroke="var(--l-accent)" strokeOpacity="0.5" strokeWidth="0.4" className="l-flow" vectorEffect="non-scaling-stroke" />
          </svg>
          {steps.map((s) => (
            <div key={s.n} className="relative text-center">
              <div className="l-card l-ring relative mx-auto flex size-28 items-center justify-center rounded-full bg-[var(--l-surface-2)]">
                <s.icon className="l-accent size-9" />
                <span className="l-display absolute -top-1 -right-1 rounded-full bg-[var(--l-bg)] px-2.5 py-1 text-xs font-semibold ring-1 ring-[var(--l-line)]">{s.n}</span>
              </div>
              <h3 className="l-display mt-7 text-xl font-semibold">{s.title}</h3>
              <p className="l-muted mx-auto mt-3 max-w-xs text-sm leading-relaxed">{s.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Developers() {
  return (
    <section id="developers" className="mx-auto grid max-w-7xl scroll-mt-20 items-center gap-14 px-4 py-24 sm:px-6 sm:py-32 lg:grid-cols-2">
      <div>
        <SectionHead center={false} eyebrow="For developers" title="An API you’ll" accent="actually enjoy." text="Clean REST, rupee-string amounts, prefixed IDs and errors that tell you what to fix. Rehearse every outcome in the sandbox before a single real rupee moves." />
        <ul className="mt-9 grid gap-4 sm:grid-cols-2">
          {[
            { icon: Repeat, t: 'Idempotency keys', d: 'Retries never double-charge or double-pay.' },
            { icon: Webhook, t: 'Signed webhooks', d: 'HMAC signatures, retries and a delivery log.' },
            { icon: Fingerprint, t: 'Request signing', d: 'HMAC-signed calls with nonce and timestamp.' },
            { icon: Lock, t: 'IP allow-listing', d: 'Only your servers can use your live keys.' },
          ].map((f) => (
            <li key={f.t} className="flex gap-3">
              <f.icon className="l-accent mt-0.5 size-5 shrink-0" />
              <div>
                <p className="font-medium">{f.t}</p>
                <p className="l-muted text-sm">{f.d}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/docs" className="l-btn l-btn-primary">
            Explore the API <ArrowRight className="size-4" />
          </Link>
          <a href="/downloads/pay2all-woocommerce-1.0.0.zip" className="l-btn l-btn-ghost">
            WooCommerce plugin
          </a>
        </div>
      </div>
      <div className="l-card l-ring overflow-hidden bg-[#03080a]/90 shadow-[0_40px_120px_-30px_rgb(0_0_0/0.9)]">
        <div className="flex items-center gap-2 border-b border-[var(--l-line)] px-5 py-3">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
          <span className="l-muted ml-3 font-mono text-xs">checkout.js — Node.js</span>
        </div>
        <pre className="l-code overflow-x-auto p-6">
          <code>
            <span className="c">{'// Create a hosted checkout and redirect the customer'}</span>
            {'\n'}
            <span className="k">const</span> session = <span className="k">await</span> pay2all(<span className="s">&apos;POST&apos;</span>, <span className="s">&apos;/v1/checkout/sessions&apos;</span>, {'{'}
            {'\n  '}merchant_order_id: <span className="s">&apos;ORD-1042&apos;</span>,{'\n  '}amount: <span className="s">&apos;2499.00&apos;</span>,{'\n  '}description: <span className="s">&apos;2 × Blue kurta&apos;</span>,{'\n  '}return_url: <span className="s">&apos;https://shop.example.com/orders/1042&apos;</span>,{'\n'}
            {'});'}
            {'\n\n'}
            res.redirect(session.url); <span className="c">{'// UPI · cards · net banking'}</span>
            {'\n\n'}
            <span className="c">{'// Webhook → payment.captured'}</span>
            {'\n'}
            {'{ '}
            <span className="s">&quot;status&quot;</span>: <span className="s">&quot;CAPTURED&quot;</span>, <span className="s">&quot;amount&quot;</span>: <span className="s">&quot;2499.00&quot;</span>
            {' }'}
          </code>
        </pre>
      </div>
    </section>
  );
}

function Security() {
  const items = [
    { icon: ShieldCheck, t: 'Two-factor everywhere', d: 'TOTP and passkeys for dashboards; step-up confirmation for sensitive actions.' },
    { icon: Lock, t: 'Encrypted at rest', d: 'KYB documents and bank details are encrypted; secrets never leave the server.' },
    { icon: BookOpenCheck, t: 'Full audit trail', d: 'Every change records who, what, when and why — with a reason.' },
    { icon: Radar, t: 'Risk engine', d: 'Rules for velocity, amount and patterns, with review queues before money moves.' },
  ];
  return (
    <section id="security" className="relative scroll-mt-20 overflow-hidden border-y border-[var(--l-line)] bg-[var(--l-surface)]/40 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHead eyebrow="Security & trust" title="Built like a bank," accent="feels like a startup." />
        <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((f) => (
            <div key={f.t} className="l-card l-card-hover p-7">
              <span className="l-icon">
                <f.icon className="size-5" />
              </span>
              <h3 className="mt-5 font-semibold">{f.t}</h3>
              <p className="l-muted mt-2 text-sm leading-relaxed">{f.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Audiences() {
  const items = [
    { icon: Store, t: 'Merchants', d: 'Online stores, SaaS, education, travel and marketplaces collecting and paying out at scale.', cta: 'Open a merchant account', href: '/signup' },
    { icon: Handshake, t: 'Resellers', d: 'Your brand, your domain, your rate cards. Onboard merchants and earn on every transaction.', cta: 'Become a reseller', href: '/signup' },
    { icon: Banknote, t: 'API partners', d: 'Embed collections and payouts inside your own platform with partner-level APIs.', cta: 'Talk to us', href: '#contact' },
  ];
  return (
    <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6 sm:py-32">
      <SectionHead eyebrow="Who it’s for" title="One platform," accent="many businesses." />
      <div className="mt-16 grid gap-5 md:grid-cols-3">
        {items.map((a) => (
          <article key={a.t} className="l-card l-card-hover flex flex-col p-8">
            <a.icon className="l-accent size-8" />
            <h3 className="l-display mt-6 text-2xl font-semibold">{a.t}</h3>
            <p className="l-muted mt-3 flex-1 leading-relaxed">{a.d}</p>
            <a href={a.href} className="l-accent mt-6 inline-flex items-center gap-1.5 text-sm font-semibold hover:gap-2.5 transition-all">
              {a.cta} <ArrowRight className="size-4" />
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}

function FinalCta({ brand }: { brand: Brand }) {
  return (
    <section id="contact" className="mx-auto max-w-7xl scroll-mt-20 px-4 pb-24 sm:px-6 sm:pb-32">
      <div className="l-card l-ring l-grain relative overflow-hidden px-6 py-16 text-center sm:px-16 sm:py-24">
        <div className="l-mesh opacity-80" />
        <div className="relative">
          <h2 className="l-display mx-auto max-w-3xl text-4xl leading-[1.05] font-semibold sm:text-6xl">
            Ready to move money <span className="l-serif l-grad-text">beautifully?</span>
          </h2>
          <p className="l-muted mx-auto mt-6 max-w-xl text-lg">Open your account in minutes. Test in the sandbox today, go live as soon as your KYB is approved.</p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className="l-btn l-btn-primary">
              Create free account <ArrowRight className="size-4" />
            </Link>
            {brand.support_email ? (
              <a href={`mailto:${brand.support_email}`} className="l-btn l-btn-ghost">
                Contact sales
              </a>
            ) : (
              <Link href="/docs" className="l-btn l-btn-ghost">
                View documentation
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function PaymentsLanding({ brand, jsonLd, nonce, preview }: { brand: Brand; jsonLd: object; nonce?: string; preview?: boolean }) {
  return (
    <LandingShell
      brand={brand}
      variant="PAYMENTS"
      nav={NAV}
      signupHref="/signup"
      jsonLd={jsonLd}
      nonce={nonce}
      preview={preview}
      footerColumns={[
        { title: 'Products', links: [{ href: '#products', label: 'Payin' }, { href: '#products', label: 'Payout' }, { href: '#products', label: 'Payment links' }, { href: '#products', label: 'Settlements' }] },
        { title: 'Developers', links: [{ href: '/docs', label: 'API reference' }, { href: '/downloads/pay2all-woocommerce-1.0.0.zip', label: 'WooCommerce' }, { href: '/downloads/pay2all-opencart-1.0.0.ocmod.zip', label: 'OpenCart' }, { href: '/downloads/pay2all-php-1.0.0.zip', label: 'PHP SDK' }] },
        { title: 'Company', links: [{ href: '/signup', label: 'Create account' }, { href: '/login', label: 'Sign in' }, { href: '#faq', label: 'FAQ' }, { href: '/llms.txt', label: 'llms.txt' }] },
      ]}
    >
      <Hero brand={brand} />
      <Rails />
      <Products />
      <How />
      <Developers />
      <Security />
      <Audiences />
      <section id="faq" className="mx-auto max-w-7xl scroll-mt-20 px-4 pb-24 sm:px-6 sm:pb-32">
        <SectionHead eyebrow="FAQ" title="Questions," accent="answered." />
        <div className="mt-14">
          <Faqs items={PAYMENTS_FAQ} />
        </div>
      </section>
      <FinalCta brand={brand} />
    </LandingShell>
  );
}
