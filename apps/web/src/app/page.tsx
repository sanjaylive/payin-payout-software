import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { CspLanding, fetchPlans } from '@/features/landing/csp-landing';
import { PaymentsLanding } from '@/features/landing/payments-landing';
import { CSP_FAQ, currentSite, jsonLd, PAYMENTS_FAQ, parseVariant, seoCopy } from '@/features/landing/site';
import { assetUrl } from '@/lib/brand/brand';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** "/" is the public landing page; which one is chosen under Admin → Settings → Landing Page. */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const site = await currentSite();
  const preview = parseVariant((await searchParams).preview);
  const variant = preview ?? site.variant;
  const copy = seoCopy(variant, site.brand);
  const image = assetUrl(site.brand.assets.logo) ?? assetUrl(site.brand.assets.icon);
  return {
    title: { absolute: copy.title },
    description: copy.description,
    keywords: copy.keywords,
    metadataBase: new URL(site.origin),
    alternates: { canonical: '/' },
    // Previews of the non-live page must never be indexed.
    robots: preview && preview !== site.variant ? { index: false, follow: false } : { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 } },
    openGraph: { type: 'website', url: '/', siteName: site.brand.product_name, title: copy.title, description: copy.description, locale: 'en_IN', ...(image ? { images: [{ url: image }] } : {}) },
    twitter: { card: image ? 'summary_large_image' : 'summary', title: copy.title, description: copy.description, ...(image ? { images: [image] } : {}) },
    other: { 'theme-color': variant === 'CSP' ? '#0f0818' : '#050f0d' },
  };
}

export default async function LandingPage({ searchParams }: Props) {
  const site = await currentSite();
  const preview = parseVariant((await searchParams).preview);
  const variant = preview ?? site.variant;
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const isPreview = Boolean(preview && preview !== site.variant);
  if (variant === 'CSP') {
    return <CspLanding brand={site.brand} plans={await fetchPlans()} jsonLd={jsonLd(site, 'CSP', CSP_FAQ)} nonce={nonce} preview={isPreview} />;
  }
  return <PaymentsLanding brand={site.brand} jsonLd={jsonLd(site, 'PAYMENTS', PAYMENTS_FAQ)} nonce={nonce} preview={isPreview} />;
}
