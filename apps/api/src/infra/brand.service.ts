import { Inject, Injectable } from '@nestjs/common';
import type { BrandAssetKind, PrismaClient, ResellerBrand } from '@pay2all/database';
import { ApiConfig } from '../config/api-config';
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
  /** Set when this is a reseller's white-label brand (docs/BRANDING.md §5). */
  owner?: { organization_id: string; custom_domain: string | null };
}

const TTL_MS = 15_000;

/**
 * The platform's white-label brand (docs/BRANDING.md). Read on every page load and email, so it is
 * cached per node for 15 s; the node that saves a change invalidates at once.
 */
@Injectable()
export class BrandService {
  private cache: { at: number; brand: Brand } | null = null;
  private readonly owners = new Map<string, { at: number; brand: Brand | null }>();
  private readonly hosts = new Map<string, { at: number; owner: string | null }>();
  private domains: { at: number; origins: Set<string> } | null = null;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly config: ApiConfig,
  ) {}

  invalidate() {
    this.cache = null;
    this.owners.clear();
    this.hosts.clear();
    this.domains = null;
  }

  // ---- White-label (reseller brands) ------------------------------------------------------------

  /** The reseller / API partner whose brand an organization shows: itself, or a merchant's parent. */
  async ownerOf(organizationId: string): Promise<string | null> {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { type: true, parent: { select: { id: true, type: true } } } });
    if (!org) return null;
    if (org.type === 'RESELLER' || org.type === 'API_PARTNER') return organizationId;
    if (org.type === 'MERCHANT' && org.parent && (org.parent.type === 'RESELLER' || org.parent.type === 'API_PARTNER')) return org.parent.id;
    return null;
  }

  private async forOwner(ownerId: string): Promise<Brand | null> {
    const hit = this.owners.get(ownerId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.brand;
    const r = await this.prisma.resellerBrand.findUnique({ where: { organizationId: ownerId }, include: { assets: { select: { kind: true, contentType: true, sha256: true, width: true, height: true, sizeBytes: true } } } });
    const brand = r ? this.merge(await this.get(), r) : null;
    this.owners.set(ownerId, { at: Date.now(), brand });
    return brand;
  }

  private merge(base: Brand, r: ResellerBrand & { assets: { kind: BrandAssetKind; contentType: string; sha256: string; width: number | null; height: number | null; sizeBytes: number }[] }): Brand {
    const asset = (kind: BrandAssetKind, fallback: Brand['assets']['logo']) => {
      const a = r.assets.find((x) => x.kind === kind);
      return a ? { url: `/v1/brand/r/${r.organizationId}/assets/${kind}?v=${a.sha256.slice(0, 16)}`, content_type: a.contentType, width: a.width, height: a.height, size_bytes: a.sizeBytes } : fallback;
    };
    return {
      ...base,
      product_name: r.productName,
      short_name: r.shortName,
      tagline: '',
      primary_color: r.primaryColor ?? base.primary_color,
      support_email: r.supportEmail ?? base.support_email,
      support_phone: r.supportPhone ?? base.support_phone,
      website_url: r.websiteUrl ?? base.website_url,
      login_headline: r.loginHeadline ?? base.login_headline,
      login_subtext: r.loginSubtext ?? base.login_subtext,
      footer_text: r.footerText ?? base.footer_text,
      version: base.version * 1000 + r.version,
      updated_at: r.updatedAt,
      assets: { logo: asset('LOGO', base.assets.logo), logo_dark: asset('LOGO_DARK', base.assets.logo_dark), icon: asset('ICON', base.assets.icon) },
      owner: { organization_id: r.organizationId, custom_domain: r.domainVerifiedAt ? r.customDomain : null },
    };
  }

  /** The brand an organization's users (and its customers) see. */
  async forOrganization(organizationId: string): Promise<Brand> {
    const owner = await this.ownerOf(organizationId);
    return (owner ? await this.forOwner(owner) : null) ?? this.get();
  }

  /** The brand for a request host: a reseller's verified custom domain, else the platform's. */
  async forHost(host: string | undefined): Promise<Brand> {
    const h = (host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!h) return this.get();
    let hit = this.hosts.get(h);
    if (!hit || Date.now() - hit.at > TTL_MS) {
      const r = await this.prisma.resellerBrand.findFirst({ where: { customDomain: h, domainVerifiedAt: { not: null } }, select: { organizationId: true } });
      hit = { at: Date.now(), owner: r?.organizationId ?? null };
      this.hosts.set(h, hit);
    }
    return (hit.owner ? await this.forOwner(hit.owner) : null) ?? this.get();
  }

  /** Base URL of customer-facing pages for a merchant: its reseller's verified domain, else the platform's. */
  async webBase(merchantId: string): Promise<string> {
    const b = await this.forOrganization(merchantId);
    return b.owner?.custom_domain ? `https://${b.owner.custom_domain}` : this.config.env.WEB_PUBLIC_URL.replace(/\/$/, '');
  }

  /** Verified custom domains as browser origins (CORS), refreshed every minute. */
  async customOrigins(): Promise<Set<string>> {
    if (this.domains && Date.now() - this.domains.at < 60_000) return this.domains.origins;
    const rows = await this.prisma.resellerBrand.findMany({ where: { domainVerifiedAt: { not: null }, customDomain: { not: null } }, select: { customDomain: true } });
    this.domains = { at: Date.now(), origins: new Set(rows.map((r) => `https://${r.customDomain}`)) };
    return this.domains.origins;
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
