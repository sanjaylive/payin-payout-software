import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { BrandAssetKind, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { BRAND_IMAGE_MAX_BYTES, type saveBrandSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { BrandService } from '../../infra/brand.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ImageRejected, inspectImage } from './image-inspect';

function platformOnly(actor: Actor) {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
}

const LABEL: Record<BrandAssetKind, string> = { LOGO: 'Logo', LOGO_DARK: 'Logo for dark backgrounds', ICON: 'Icon' };

/** Brand administration: settings, and logo / icon uploads (docs/BRANDING.md). */
@Injectable()
export class BrandSettingsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly brand: BrandService,
    private readonly audit: AuditService,
  ) {}

  async save(actor: Actor, input: z.output<typeof saveBrandSchema>) {
    platformOnly(actor);
    const data = {
      productName: input.product_name,
      shortName: input.short_name,
      companyName: input.company_name,
      tagline: input.tagline,
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
      const before = await tx.brandSettings.findUnique({ where: { id: 'default' } });
      if (input.version !== undefined && (before?.version ?? 0) !== input.version) throw new AppError(ErrorCode.CONFLICT, 'Someone else changed the brand; reload and try again');
      if (before) {
        const n = await tx.brandSettings.updateMany({ where: { id: 'default', version: before.version }, data: { ...data, version: { increment: 1 } } });
        if (n.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'Someone else changed the brand; reload and try again');
      } else {
        await tx.brandSettings.create({ data: { id: 'default', ...data } });
      }
      const { reason, version: _v, ...after } = input;
      await this.audit.record({ action: 'brand.updated', resourceType: 'brand', resourceId: 'default', organizationId: null, oldValue: before ? { product_name: before.productName, short_name: before.shortName, company_name: before.companyName, primary_color: before.primaryColor, support_email: before.supportEmail } : null, newValue: after, metadata: { reason } }, tx);
    });
    this.brand.invalidate();
    return this.brand.get();
  }

  async upload(actor: Actor, kind: BrandAssetKind, file: { buffer: Buffer; size: number } | undefined, reason: string) {
    platformOnly(actor);
    if (!file || file.size === 0) throw new AppError(ErrorCode.INVALID_REQUEST, 'Choose an image to upload');
    if (file.size > BRAND_IMAGE_MAX_BYTES) throw new AppError(ErrorCode.INVALID_REQUEST, 'Images can be at most 1 MB');
    let img;
    try {
      img = inspectImage(file.buffer);
    } catch (err) {
      if (err instanceof ImageRejected) throw new AppError(ErrorCode.INVALID_REQUEST, err.message, [{ path: 'file', message: err.message }]);
      throw err;
    }
    const { width: w, height: h } = img;
    if (w !== null && h !== null) {
      if (w > 4096 || h > 4096) throw new AppError(ErrorCode.INVALID_REQUEST, 'Images can be at most 4096 × 4096 pixels');
      const raster = img.type !== 'image/svg+xml';
      if (kind === 'ICON') {
        if (Math.max(w, h) / Math.min(w, h) > 1.25) throw new AppError(ErrorCode.INVALID_REQUEST, `The icon should be square (this one is ${w} × ${h})`);
        if (raster && Math.min(w, h) < 32) throw new AppError(ErrorCode.INVALID_REQUEST, `The icon should be at least 32 × 32 pixels (this one is ${w} × ${h})`);
      } else {
        if (img.type === 'image/x-icon') throw new AppError(ErrorCode.INVALID_REQUEST, 'Use PNG, JPEG, WebP or SVG for logos');
        if (raster && h < 24) throw new AppError(ErrorCode.INVALID_REQUEST, `The logo should be at least 24 pixels tall (this one is ${h})`);
      }
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const data = { contentType: img.type, bytes: new Uint8Array(file.buffer), sizeBytes: file.size, sha256, width: w, height: h, updatedById: actor.userId };
    await this.prisma.$transaction(async (tx) => {
      await tx.brandAsset.upsert({ where: { kind }, create: { kind, ...data }, update: data });
      await this.audit.record({ action: 'brand.asset_uploaded', resourceType: 'brand_asset', resourceId: kind, organizationId: null, newValue: { kind, content_type: img.type, size_bytes: file.size, width: w, height: h, sha256 }, metadata: { reason } }, tx);
    });
    this.brand.invalidate();
    return this.brand.get();
  }

  async remove(actor: Actor, kind: BrandAssetKind, reason: string) {
    platformOnly(actor);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.brandAsset.deleteMany({ where: { kind } });
      if (!count) throw new AppError(ErrorCode.NOT_FOUND, `No ${LABEL[kind].toLowerCase()} uploaded`);
      await this.audit.record({ action: 'brand.asset_removed', resourceType: 'brand_asset', resourceId: kind, organizationId: null, metadata: { reason } }, tx);
    });
    this.brand.invalidate();
    return this.brand.get();
  }

  async asset(kind: BrandAssetKind) {
    return this.prisma.brandAsset.findUnique({ where: { kind } });
  }
}
