import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { headers } from 'next/headers';
import type { CSSProperties, ReactNode } from 'react';
import { assetUrl, colorVars, fetchBrand } from '@/lib/brand/brand';
import { Providers } from './providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });

/** Title, description and favicon come from Settings → Brand. */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await fetchBrand((await headers()).get('host'));
  const icon = assetUrl(brand.assets.icon);
  return {
    title: { default: brand.product_name, template: `%s · ${brand.product_name}` },
    description: brand.tagline || brand.product_name,
    applicationName: brand.product_name,
    robots: { index: false, follow: false },
    icons: icon ? { icon: [{ url: icon, type: brand.assets.icon!.content_type }], apple: icon } : { icon: '/favicon.ico' },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Per-request CSP nonce from src/proxy.ts (forces dynamic rendering, which the dashboard needs anyway).
  const h = await headers();
  const nonce = h.get('x-nonce') ?? undefined;
  const brand = await fetchBrand(h.get('host'));
  return (
    <html
      lang="en-IN"
      suppressHydrationWarning
      className={`${inter.variable} ${mono.variable}`}
      style={colorVars(brand.primary_color) as CSSProperties}
      {...(brand.primary_color ? { 'data-brand-color': '' } : {})}
    >
      <body className="min-h-dvh font-sans">
        <Providers nonce={nonce} brand={brand}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
