import type { LandingVariant } from '@pay2all/validation';
import { headers } from 'next/headers';
import { type Brand, fetchBrand } from '@/lib/brand/brand';

/** Server-only helpers shared by the landing page, robots.txt, sitemap.xml and llms.txt. */

export interface Site {
  brand: Brand;
  /** Absolute origin of this request, e.g. https://pay.example.com (works for reseller domains too). */
  origin: string;
  variant: LandingVariant;
}

export async function currentSite(): Promise<Site> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const local = /^(localhost|127\.|0\.0\.0\.0)/.test(host);
  const proto = h.get('x-forwarded-proto')?.split(',')[0]?.trim() || (local ? 'http' : 'https');
  const brand = await fetchBrand(host);
  return { brand, origin: `${proto}://${host}`, variant: brand.landing_variant ?? 'PAYMENTS' };
}

export function parseVariant(v: string | string[] | undefined): LandingVariant | null {
  const s = (Array.isArray(v) ? v[0] : v)?.toUpperCase();
  return s === 'PAYMENTS' || s === 'CSP' ? s : null;
}

// ---- Copy shared by the page, metadata, JSON-LD and llms.txt -------------------------------------

export interface Faq {
  q: string;
  a: string;
}

export function seoCopy(variant: LandingVariant, brand: Brand) {
  const name = brand.product_name;
  if (variant === 'CSP') {
    return {
      title: `${name} — Digital counter register for CSP agents & retailers`,
      description: `Record every money transfer, AEPS cash withdrawal, cash deposit, bill payment and recharge at your customer service point. Instant receipts on WhatsApp, a live cash book, staff logins and Google Drive backup — free to start.`,
      keywords: ['CSP software', 'customer service point', 'DMT register', 'AEPS record', 'money transfer receipt', 'retailer cash book', 'bank mitra software', 'agent counter app', 'digital khata for CSP', 'recharge and bill payment register'],
    };
  }
  return {
    title: `${name} — Payin & Payout gateway for Indian businesses`,
    description: `Collect with UPI, cards, net banking, payment links and QR. Send instant payouts over IMPS, NEFT, RTGS and UPI. Settlements, a double-entry ledger, smart routing and developer-first APIs — on one platform.`,
    keywords: ['payment gateway India', 'payout API', 'UPI collection', 'IMPS payout', 'bulk payouts', 'payment links', 'UPI QR', 'settlements', 'payin payout platform', 'white-label payment gateway'],
  };
}

export const PAYMENTS_FAQ: Faq[] = [
  { q: 'Which payment methods can my customers use?', a: 'UPI (intent, collect and dynamic QR), static UPI QR, debit and credit cards, and net banking — through hosted checkout, payment links, payment pages or the API.' },
  { q: 'How do payouts work?', a: 'Add funds to your payout balance, then send money to any bank account or UPI ID over IMPS, NEFT, RTGS or UPI — one at a time from the dashboard, in bulk from a CSV, or programmatically with the Payout API.' },
  { q: 'Is the API idempotent and safe to retry?', a: 'Yes. Every money-moving request takes an idempotency key, so a retried request never charges or pays twice. Webhooks are signed with HMAC and retried with backoff.' },
  { q: 'How are balances kept accurate?', a: 'Every rupee is posted to a double-entry ledger. Collections, refunds, fees, settlements and payouts each create balanced journal entries you can audit and reconcile.' },
  { q: 'Can I resell the platform under my own brand?', a: 'Yes. Resellers and API partners get their own logo, colours and custom domain, manage their merchants and earn commission on their rate cards.' },
  { q: 'Do you have plugins for my store?', a: 'Ready-made plugins are available for WooCommerce, OpenCart and plain PHP, plus a drop-in checkout.js script and REST APIs for any stack.' },
];

export const CSP_FAQ: Faq[] = [
  { q: 'Does this app move money?', a: 'No. You do the real transaction on your bank CSP portal, AEPS device or UPI app as usual. This is your counter register: it records each entry, prints or shares the receipt and keeps your cash book.' },
  { q: 'Which services can I record?', a: 'Money transfer (DMT), AEPS / micro-ATM cash withdrawal, cash deposit, bill payments, mobile and DTH recharges, and any other service with your own service charge.' },
  { q: 'How do customers get a receipt?', a: 'Every entry gets a numbered receipt. Print it, or share a secure link on WhatsApp. Business plan shops can send receipts automatically by SMS or WhatsApp.' },
  { q: 'Can my staff use it?', a: 'Yes. Add counter staff with their own logins. Staff can record entries; only the owner manages settings, plans and reports.' },
  { q: 'Is my customers’ data safe?', a: 'ID and bank account numbers are encrypted at rest, each shop sees only its own data, and you can back everything up to your own Google Drive.' },
  { q: 'Is there a mobile app?', a: 'Yes. Use the web counter on any computer, or the Android app at the counter — both work with the same account.' },
];

export function jsonLd(site: Site, variant: LandingVariant, faq: Faq[]) {
  const { brand, origin } = site;
  const copy = seoCopy(variant, brand);
  const logo = brand.assets.logo?.url ?? brand.assets.icon?.url;
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
  const contact = [brand.support_email && { '@type': 'ContactPoint', contactType: 'customer support', email: brand.support_email, areaServed: 'IN', availableLanguage: ['en', 'hi'] }, brand.support_phone && { '@type': 'ContactPoint', contactType: 'customer support', telephone: brand.support_phone, areaServed: 'IN' }].filter(Boolean);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${origin}/#org`,
        name: brand.company_name,
        brand: brand.product_name,
        url: brand.website_url ?? origin,
        ...(logo ? { logo: `${apiBase}${logo}` } : {}),
        ...(contact.length ? { contactPoint: contact } : {}),
      },
      { '@type': 'WebSite', '@id': `${origin}/#website`, url: origin, name: brand.product_name, description: copy.description, publisher: { '@id': `${origin}/#org` }, inLanguage: 'en-IN' },
      {
        '@type': 'SoftwareApplication',
        name: brand.product_name,
        applicationCategory: variant === 'CSP' ? 'BusinessApplication' : 'FinanceApplication',
        operatingSystem: variant === 'CSP' ? 'Web, Android' : 'Web',
        description: copy.description,
        url: origin,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR', description: variant === 'CSP' ? 'Free plan available' : 'Free to sign up' },
        publisher: { '@id': `${origin}/#org` },
      },
      { '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    ],
  };
}

/** Markdown for /llms.txt (https://llmstxt.org): a plain summary AI assistants can read and cite. */
export function llmsText(site: Site) {
  const { brand, origin, variant } = site;
  const copy = seoCopy(variant, brand);
  const faq = variant === 'CSP' ? CSP_FAQ : PAYMENTS_FAQ;
  const contact = [brand.support_email && `- Email: ${brand.support_email}`, brand.support_phone && `- Phone: ${brand.support_phone}`, brand.website_url && `- Website: ${brand.website_url}`].filter(Boolean).join('\n');
  const product =
    variant === 'CSP'
      ? `## Product
${brand.product_name} is a digital counter register for customer service points (CSP), bank mitras, AEPS agents and retail shops in India.

- Record money transfers (DMT), AEPS / micro-ATM cash withdrawals, cash deposits, bill payments and recharges
- Numbered receipts: print, share a secure link on WhatsApp, or send automatically by SMS / WhatsApp (Business plan)
- Customers and their beneficiaries (bank account / UPI) saved once, reused every visit
- Live cash book: cash in, cash out and service-charge earnings for the day
- Staff logins with owner / operator roles
- Reports and CSV exports; Google Drive backup
- Web counter and Android app
- It does not move money itself: the agent completes the real transaction on their bank portal or UPI app

## Plans
- Free: ₹0, 100 entries a month, 1 login
- Starter: 2,000 entries a month, 3 logins, Google Drive backup, branded receipts
- Business: unlimited entries, 10 logins, automatic SMS / WhatsApp receipts
(Prices are shown on the website and may change.)`
      : `## Product
${brand.product_name} is a payin and payout platform for Indian businesses, operated by ${brand.company_name.replace(/\.$/, '')}.

- Payin: UPI intent / collect / dynamic QR, static UPI QR, cards, net banking, hosted checkout, payment links and payment pages
- Payout: IMPS, NEFT, RTGS and UPI transfers to bank accounts and UPI IDs; bulk payouts from CSV; beneficiary management
- Settlements to the merchant's bank account, with statements and invoices
- Double-entry ledger behind every balance; reconciliation and audit logs
- Smart routing across multiple providers with health monitoring and failover
- Developer APIs: REST, idempotency keys, HMAC-signed webhooks, API keys, IP allow-listing, sandbox and live modes
- Plugins: WooCommerce, OpenCart, PHP; checkout.js drop-in
- Risk rules, disputes and refunds
- Reseller and API-partner programme with white-label branding and custom domains`;
  return `# ${brand.product_name}

> ${copy.description}

${product}

## Key pages
- [Home](${origin}/): overview
- [Create an account](${origin}/signup${variant === 'CSP' ? '?type=agent' : ''})
- [Sign in](${origin}/login)
${variant === 'PAYMENTS' ? `- [API documentation](${origin}/docs)\n` : ''}
## FAQ
${faq.map((f) => `### ${f.q}\n${f.a}`).join('\n\n')}

## Contact
- Company: ${brand.company_name}
${contact}
`;
}
