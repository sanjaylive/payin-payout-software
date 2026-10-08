import { Inject, Injectable } from '@nestjs/common';
import type { BrandAssetKind, PrismaClient } from '@pay2all/database';
import { BRAND_DEFAULTS } from '@pay2all/validation';
import { PRISMA } from './tokens';

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
  updated_at: Date | null;
  /** Relative API paths with a content hash, so they can be cached forever. */
  assets: Record<'logo' | 'logo_dark' | 'icon', { url: string; content_type: string; width: number | null; height: number | null; size_bytes: number } | null>;
}

const TTL_MS = 15_000;

/**
 * The platform's white-label brand (docs/BRANDING.md). Read on every page load and email, so it is
 * cached per node for 15 s; the node that saves a change invalidates at once.
 */
@Injectable()
export class BrandService {
  private cache: { at: number; brand: Brand } | null = null;

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  invalidate() {
    this.cache = null;
  }

  async get(): Promise<Brand> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.brand;
    const [s, assets] = await Promise.all([
      this.prisma.brandSettings.findUnique({ where: { id: 'default' } }),
      this.prisma.brandAsset.findMany({ select: { kind: true, contentType: true, sha256: true, width: true, height: true, sizeBytes: true } }),
    ]);
    const asset = (kind: BrandAssetKind) => {
      const a = assets.find((x) => x.kind === kind);
      return a ? { url: `/v1/brand/assets/${kind}?v=${a.sha256.slice(0, 16)}`, content_type: a.contentType, width: a.width, height: a.height, size_bytes: a.sizeBytes } : null;
    };
    const brand: Brand = {
      ...BRAND_DEFAULTS,
      ...(s
        ? {
            product_name: s.productName,
            short_name: s.shortName,
            company_name: s.companyName,
            tagline: s.tagline,
            primary_color: s.primaryColor,
            support_email: s.supportEmail,
            support_phone: s.supportPhone,
            website_url: s.websiteUrl,
            login_headline: s.loginHeadline,
            login_subtext: s.loginSubtext,
            footer_text: s.footerText,
          }
        : {}),
      version: s?.version ?? 0,
      updated_at: s?.updatedAt ?? null,
      assets: { logo: asset('LOGO'), logo_dark: asset('LOGO_DARK'), icon: asset('ICON') },
    };
    this.cache = { at: Date.now(), brand };
    return brand;
  }

  /**
   * Fills {{product}} / {{short}} / {{company}} in outgoing message text, and adds a signature with
   * the support contact to emails.
   */
  async render(subject: string | undefined, text: string, channel: 'EMAIL' | 'SMS' | 'WHATSAPP') {
    const b = await this.get();
    const fill = (s: string) => s.replaceAll('{{product}}', b.product_name).replaceAll('{{short}}', b.short_name).replaceAll('{{company}}', b.company_name);
    let body = fill(text);
    if (channel === 'EMAIL') {
      const contact = [b.support_email, b.support_phone].filter(Boolean).join(' · ');
      body += `\n\n—\n${b.product_name}${contact ? `\nSupport: ${contact}` : ''}`;
    }
    return { subject: subject === undefined ? undefined : fill(subject), text: body };
  }
}
