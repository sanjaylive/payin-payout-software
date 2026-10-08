import { BRAND_DEFAULTS } from '@pay2all/validation';

export interface BrandAsset {
  url: string;
  content_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
}
export interface Brand {
  product_name: string;
  short_name: string;
  company_name: string;
  tagline: string;
  primary_color: string | null;
  support_email: string | null;
  support_phone: string | null;
  website_url: string | null;
  login_headline: string;
  login_subtext: string;
  footer_text: string | null;
  version: number;
  updated_at: string | null;
  assets: { logo: BrandAsset | null; logo_dark: BrandAsset | null; icon: BrandAsset | null };
}

export const DEFAULT_BRAND: Brand = { ...BRAND_DEFAULTS, version: 0, updated_at: null, assets: { logo: null, logo_dark: null, icon: null } };

const PUBLIC_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
/** Absolute URL of a brand image (served by the API, cacheable forever thanks to ?v=). */
export const assetUrl = (a: BrandAsset | null | undefined) => (a ? `${PUBLIC_API}${a.url}` : null);

/** Server-side read for metadata and first paint. Never blocks a page on the API: defaults after 1.5 s. */
export async function fetchBrand(): Promise<Brand> {
  const base = process.env.API_INTERNAL_URL || PUBLIC_API;
  try {
    const res = await fetch(`${base}/v1/brand`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (!res.ok) return DEFAULT_BRAND;
    const body = (await res.json()) as { data?: Brand };
    return body.data ?? DEFAULT_BRAND;
  } catch {
    return DEFAULT_BRAND;
  }
}

// ---- Colour --------------------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]: [number, number, number]) {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
/** Mix towards white by `t` (dark mode uses a lighter shade of the brand colour). */
function lighten(hex: string, t: number) {
  const [r, g, b] = rgb(hex).map((v) => Math.round(v + (255 - v) * t)) as [number, number, number];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
const fgFor = (hex: string) => (contrast(hex, '#ffffff') >= contrast(hex, '#0b1220') ? '#ffffff' : '#0b1220');

/** CSS variables for the brand colour, consumed by `html[data-brand-color]` in globals.css. */
export function colorVars(hex: string | null): Record<string, string> {
  if (!hex) return {};
  const dark = lighten(hex, 0.22);
  return { '--brand-primary': hex, '--brand-primary-fg': fgFor(hex), '--brand-primary-dark': dark, '--brand-primary-dark-fg': fgFor(dark) };
}
