import { randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { Inject, Injectable } from '@nestjs/common';
import type { BrandAssetKind, PrismaClient, ResellerBrand } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type { saveResellerBrandSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { BrandService } from '../../infra/brand.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { checkBrandImage } from './brand-settings.service';

/** DNS record that proves a reseller controls its custom domain. */
export const verificationRecord = (domain: string) => `_pay2all-verify.${domain}`;
const verificationValue = (token: string) => `pay2all-verify=${token}`;

/**
 * Reseller white-label (docs/BRANDING.md §5): a reseller / API partner sets its own names, colour,
 * contact and logos, and optionally a custom domain proven by a DNS TXT record. Only its own
 * organization: tenant context comes from the session, never from input.
 */
@Injectable()
export class ResellerBrandService {
  /** Overridable in tests. */
  resolveTxt = (name: string): Promise<string[][]> => dns.resolveTxt(name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly brand: BrandService,
    private readonly audit: AuditService,
    private readonly config: ApiConfig,
  ) {}

  private owner(actor: Actor) {
    if (actor.organizationType !== 'RESELLER' && actor.organizationType !== 'API_PARTNER') throw new AppError(ErrorCode.FORBIDDEN, 'White-label branding is for resellers and API partners');
    return actor.organizationId;
  }

  private present(r: ResellerBrand | null, assets: { kind: BrandAssetKind }[] = []) {
    if (!r) return { configured: false, brand: null, domain: null };
    return {
      configured: true,
      brand: {
        product_name: r.productName,
        short_name: r.shortName,
        primary_color: r.primaryColor,
        support_email: r.supportEmail,
        support_phone: r.supportPhone,
        website_url: r.websiteUrl,
        login_headline: r.loginHeadline,
        login_subtext: r.loginSubtext,
        footer_text: r.footerText,
        logos: assets.map((a) => a.kind),
        version: r.version,
        updated_at: r.updatedAt,
      },
      domain: r.customDomain
        ? {
            name: r.customDomain,
            verified: Boolean(r.domainVerifiedAt),
            verified_at: r.domainVerifiedAt,
            dns: { type: 'TXT', name: verificationRecord(r.customDomain), value: verificationValue(r.domainToken!) },
          }
        : null,
    };
  }

  async get(actor: Actor) {
    const orgId = this.owner(actor);
    const r = await this.prisma.resellerBrand.findUnique({ where: { organizationId: orgId }, include: { assets: { select: { kind: true } } } });
    return { ...this.present(r, r?.assets), effective: await this.brand.forOrganization(orgId) };
  }

  async save(actor: Actor, input: z.output<typeof saveResellerBrandSchema>) {
    const orgId = this.owner(actor);
    const data = {
      productName: input.product_name,
      shortName: input.short_name,
      primaryColor: input.primary_color,
      supportEmail: input.support_email,
      supportPhone: input.support_phone,
      websiteUrl: input.website_url,
      loginHeadline: input.login_headline,
      loginSubtext: input.login_subtext,
      footerText: input.footer_text,
      updatedById: actor.userId,
    };
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.resellerBrand.findUnique({ where: { organizationId: orgId } });
      await tx.resellerBrand.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, ...data }, update: { ...data, version: { increment: 1 } } });
      await this.audit.record({ action: 'reseller_brand.updated', resourceType: 'reseller_brand', resourceId: orgId, organizationId: orgId, oldValue: before ? { product_name: before.productName, primary_color: before.primaryColor } : null, newValue: { product_name: input.product_name, primary_color: input.primary_color } }, tx);
    });
    this.brand.invalidate();
    return this.get(actor);
  }

  private async requireBrand(orgId: string) {
    const r = await this.prisma.resellerBrand.findUnique({ where: { organizationId: orgId } });
    if (!r) throw new AppError(ErrorCode.INVALID_REQUEST, 'Save your brand name first');
    return r;
  }

  async upload(actor: Actor, kind: BrandAssetKind, file: { buffer: Buffer; size: number } | undefined) {
    const orgId = this.owner(actor);
    await this.requireBrand(orgId);
    const { img, sha256, file: f } = checkBrandImage(kind, file);
    const data = { contentType: img.type, bytes: new Uint8Array(f.buffer), sizeBytes: f.size, sha256, width: img.width, height: img.height, updatedById: actor.userId };
    await this.prisma.$transaction(async (tx) => {
      await tx.resellerBrandAsset.upsert({ where: { organizationId_kind: { organizationId: orgId, kind } }, create: { organizationId: orgId, kind, ...data }, update: data });
      await this.audit.record({ action: 'reseller_brand.asset_uploaded', resourceType: 'reseller_brand', resourceId: orgId, organizationId: orgId, newValue: { kind, content_type: img.type, size_bytes: f.size, sha256 } }, tx);
    });
    this.brand.invalidate();
    return this.get(actor);
  }

  async removeAsset(actor: Actor, kind: BrandAssetKind) {
    const orgId = this.owner(actor);
    const n = await this.prisma.resellerBrandAsset.deleteMany({ where: { organizationId: orgId, kind } });
    if (!n.count) throw new AppError(ErrorCode.NOT_FOUND, 'No image uploaded');
    await this.audit.record({ action: 'reseller_brand.asset_removed', resourceType: 'reseller_brand', resourceId: orgId, organizationId: orgId, metadata: { kind } });
    this.brand.invalidate();
    return this.get(actor);
  }

  async asset(orgId: string, kind: BrandAssetKind) {
    return this.prisma.resellerBrandAsset.findUnique({ where: { organizationId_kind: { organizationId: orgId, kind } } });
  }

  // ---- Custom domain ------------------------------------------------------------------------------

  async setDomain(actor: Actor, domain: string) {
    const orgId = this.owner(actor);
    await this.requireBrand(orgId);
    if (domain === new URL(this.config.env.WEB_PUBLIC_URL).hostname || domain === new URL(this.config.env.API_PUBLIC_URL).hostname) throw new AppError(ErrorCode.INVALID_REQUEST, 'That is the platform’s own domain');
    const taken = await this.prisma.resellerBrand.findFirst({ where: { customDomain: domain, organizationId: { not: orgId } }, select: { organizationId: true } });
    if (taken) throw new AppError(ErrorCode.CONFLICT, 'This domain is already used by another account');
    await this.prisma.$transaction(async (tx) => {
      await tx.resellerBrand.update({ where: { organizationId: orgId }, data: { customDomain: domain, domainToken: randomBytes(18).toString('base64url'), domainVerifiedAt: null, version: { increment: 1 } } });
      await this.audit.record({ action: 'reseller_brand.domain_set', resourceType: 'reseller_brand', resourceId: orgId, organizationId: orgId, newValue: { domain }, metadata: { severity: 'MEDIUM' } }, tx);
    });
    this.brand.invalidate();
    return this.get(actor);
  }

  /** Looks up the TXT record now; the domain starts serving the brand once it matches. */
  async verifyDomain(actor: Actor) {
    const orgId = this.owner(actor);
    const r = await this.requireBrand(orgId);
    if (!r.customDomain || !r.domainToken) throw new AppError(ErrorCode.INVALID_REQUEST, 'Add a custom domain first');
    let records: string[][] = [];
    try {
      records = await this.resolveTxt(verificationRecord(r.customDomain));
    } catch {
      records = [];
    }
    const expected = verificationValue(r.domainToken);
    if (!records.some((chunks) => chunks.join('') === expected)) {
      throw new AppError(ErrorCode.INVALID_REQUEST, `The TXT record ${verificationRecord(r.customDomain)} wasn’t found yet. DNS changes can take a while to appear — try again later.`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.resellerBrand.update({ where: { organizationId: orgId }, data: { domainVerifiedAt: new Date(), version: { increment: 1 } } });
      await this.audit.record({ action: 'reseller_brand.domain_verified', resourceType: 'reseller_brand', resourceId: orgId, organizationId: orgId, newValue: { domain: r.customDomain }, metadata: { severity: 'MEDIUM' } }, tx);
    });
    this.brand.invalidate();
    return this.get(actor);
  }

  async removeDomain(actor: Actor) {
    const orgId = this.owner(actor);
    const r = await this.requireBrand(orgId);
    if (!r.customDomain) return this.get(actor);
    await this.prisma.$transaction(async (tx) => {
      await tx.resellerBrand.update({ where: { organizationId: orgId }, data: { customDomain: null, domainToken: null, domainVerifiedAt: null, version: { increment: 1 } } });
      await this.audit.record({ action: 'reseller_brand.domain_removed', resourceType: 'reseller_brand', resourceId: orgId, organizationId: orgId, oldValue: { domain: r.customDomain } }, tx);
    });
    this.brand.invalidate();
    return this.get(actor);
  }
}
