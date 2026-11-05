import type { LandingVariant } from '@pay2all/validation';
import { Menu } from 'lucide-react';
import { Bricolage_Grotesque, Instrument_Serif } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { assetUrl, type Brand } from '@/lib/brand/brand';
import { NavAccount } from './nav-account';
import './landing.css';

const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display', display: 'swap', weight: ['500', '600', '700', '800'] });
const serif = Instrument_Serif({ subsets: ['latin'], variable: '--font-serif', display: 'swap', weight: '400', style: ['italic'] });

export interface NavItem {
  href: string;
  label: string;
}

/** Built-in mark in the landing palette (used when no logo is uploaded under Settings → Brand). */
function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
      <defs>
        <linearGradient id="l-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--l-accent)" />
          <stop offset="1" stopColor="var(--l-accent-2)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#l-mark)" />
      <path d="M9 13h11l-3.5-3.5M23 19H12l3.5 3.5" fill="none" stroke="var(--l-accent-ink)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ brand }: { brand: Brand }) {
  const logo = assetUrl(brand.assets.logo_dark) ?? null;
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element -- served by the API with its own caching
    return <img src={logo} alt={brand.product_name} className="h-8 w-auto max-w-[180px] object-contain" />;
  }
  const icon = assetUrl(brand.assets.icon);
  return (
    <span className="inline-flex items-center gap-2.5">
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={icon} alt="" className="size-8 rounded-lg object-contain" />
      ) : (
        <Mark />
      )}
      <span className="l-display text-lg font-semibold">{brand.product_name}</span>
    </span>
  );
}

export function LandingShell({
  brand,
  variant,
  nav,
  signupHref,
  jsonLd,
  nonce,
  preview,
  footerColumns,
  children,
}: {
  brand: Brand;
  variant: LandingVariant;
  nav: NavItem[];
  signupHref: string;
  jsonLd: object;
  nonce?: string;
  preview?: boolean;
  footerColumns: { title: string; links: NavItem[] }[];
  children: ReactNode;
}) {
  const year = new Date().getFullYear();
  return (
    <div className={`landing ${display.variable} ${serif.variable} min-h-dvh`} data-variant={variant}>
      {/* JSON-LD is data, not script. React writes <script> text unescaped, so "<" is escaped here and brand text can never close the tag. */}
      <script type="application/ld+json" nonce={nonce}>
        {JSON.stringify(jsonLd).replace(/</g, '\\u003c')}
      </script>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-black">
        Skip to content
      </a>
      {preview && (
        <div className="relative z-50 bg-[var(--l-accent)] px-4 py-1.5 text-center text-xs font-semibold text-[var(--l-accent-ink)]">
          Preview — this landing page is not live. Switch it under Admin → Settings → Landing Page.
        </div>
      )}
      <header className="l-nav sticky top-0 z-40">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" aria-label={`${brand.product_name} home`} className="min-w-0">
            <Logo brand={brand} />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-8 text-sm font-medium lg:flex">
            {nav.map((n) => (
              <a key={n.href} href={n.href} className="l-link">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <NavAccount signupHref={signupHref} />
            <details className="l-menu relative lg:hidden">
              <summary aria-label="Open menu" className="l-btn l-btn-ghost l-btn-sm cursor-pointer !px-2.5">
                <Menu className="size-5" />
              </summary>
              <div className="l-card absolute right-0 mt-3 flex w-56 flex-col gap-1 bg-[var(--l-surface)] p-2 shadow-2xl">
                {nav.map((n) => (
                  <a key={n.href} href={n.href} className="l-link rounded-lg px-3 py-2 text-sm hover:bg-white/5">
                    {n.label}
                  </a>
                ))}
                <Link href="/login" className="l-link rounded-lg px-3 py-2 text-sm hover:bg-white/5">
                  Sign in
                </Link>
              </div>
            </details>
          </div>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="border-t border-[var(--l-line)]">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="space-y-4">
            <Logo brand={brand} />
            <p className="l-muted max-w-xs text-sm leading-relaxed">{brand.tagline}</p>
            <div className="l-muted space-y-1 text-sm">
              {brand.support_email && (
                <p>
                  <a className="l-link" href={`mailto:${brand.support_email}`}>
                    {brand.support_email}
                  </a>
                </p>
              )}
              {brand.support_phone && (
                <p>
                  <a className="l-link" href={`tel:${brand.support_phone.replace(/[\s-]/g, '')}`}>
                    {brand.support_phone}
                  </a>
                </p>
              )}
            </div>
          </div>
          {footerColumns.map((c) => (
            <div key={c.title}>
              <p className="mb-4 text-sm font-semibold">{c.title}</p>
              <ul className="space-y-2.5 text-sm">
                {c.links.map((l) => (
                  <li key={l.href + l.label}>
                    <a href={l.href} className="l-link">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-[var(--l-line)]">
          <div className="l-muted mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>
              © {year} {brand.company_name}. All rights reserved.
            </p>
            {brand.footer_text && <p>{brand.footer_text}</p>}
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Section heading used by both landing pages. */
export function SectionHead({ eyebrow, title, accent, text, center = true }: { eyebrow: string; title: string; accent?: string; text?: string; center?: boolean }) {
  return (
    <div className={center ? 'mx-auto max-w-3xl text-center' : 'max-w-2xl'}>
      <p className="l-accent mb-4 text-xs font-semibold tracking-[0.22em] uppercase">{eyebrow}</p>
      <h2 className="l-display text-3xl leading-[1.08] font-semibold sm:text-5xl">
        {title} {accent && <span className="l-serif l-grad-text">{accent}</span>}
      </h2>
      {text && <p className="l-muted mt-5 text-base leading-relaxed sm:text-lg">{text}</p>}
    </div>
  );
}

export function Faqs({ items }: { items: { q: string; a: string }[] }) {
  return (
    <div className="mx-auto max-w-3xl divide-y divide-[var(--l-line)] rounded-[var(--l-radius)] border border-[var(--l-line)] bg-white/[0.02]">
      {items.map((f, i) => (
        <details key={f.q} className="l-faq group px-6 py-5" open={i === 0}>
          <summary className="flex items-center justify-between gap-6 text-left text-base font-medium">
            <h3>{f.q}</h3>
            <span className="l-plus l-accent text-2xl leading-none font-light" aria-hidden>
              +
            </span>
          </summary>
          <p className="l-muted mt-3 pr-8 text-sm leading-relaxed sm:text-base">{f.a}</p>
        </details>
      ))}
    </div>
  );
}
