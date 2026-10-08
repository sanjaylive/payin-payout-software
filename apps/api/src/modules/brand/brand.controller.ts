import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BRAND_ASSET_KINDS, BRAND_IMAGE_MAX_BYTES, brandAssetReasonSchema, customDomainSchema, idSchema, saveBrandSchema, saveResellerBrandSchema } from '@pay2all/validation';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { BrandService } from '../../infra/brand.service';
import { AllowRestrictedSession, AuthenticatedOnly, CurrentActor, Public, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { BrandSettingsService } from './brand-settings.service';
import { ResellerBrandService } from './reseller-brand.service';

const kindPipe = new ZodValidationPipe(z.enum(BRAND_ASSET_KINDS));
type Kind = (typeof BRAND_ASSET_KINDS)[number];

@ApiTags('Brand')
@Controller('v1/brand')
export class BrandController {
  constructor(
    private readonly brand: BrandService,
    private readonly settings: BrandSettingsService,
    private readonly resellers: ResellerBrandService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Public brand: names, colour, contact, sign-in text and asset URLs (a reseller’s for its verified custom domain)' })
  get(@Query('host') host?: string) {
    return host ? this.brand.forHost(host.slice(0, 253)) : this.brand.get();
  }

  @Get('mine')
  @AuthenticatedOnly()
  @AllowRestrictedSession()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The brand your organization sees (a reseller’s white-label brand, or the platform’s)' })
  mine(@CurrentActor() actor: Actor) {
    return this.brand.forOrganization(actor.organizationId);
  }

  @Get('r/:orgId/assets/:kind')
  @Public()
  @ApiOperation({ summary: 'A reseller brand image (public)' })
  async resellerAsset(@Param('orgId', new ZodValidationPipe(idSchema('org'))) orgId: string, @Param('kind', kindPipe) kind: Kind, @Query('v') v: string | undefined, @Res() res: Response) {
    return this.sendAsset(await this.resellers.asset(orgId, kind), v, res);
  }

  @Get('assets/:kind')
  @Public()
  @ApiOperation({ summary: 'A brand image (public; cache forever when ?v matches)' })
  async asset(@Param('kind', kindPipe) kind: Kind, @Query('v') v: string | undefined, @Res() res: Response) {
    return this.sendAsset(await this.settings.asset(kind), v, res);
  }

  private sendAsset(a: { sha256: string; contentType: string; sizeBytes: number; bytes: Uint8Array } | null, v: string | undefined, res: Response) {
    if (!a) {
      res.status(404).setHeader('Cache-Control', 'no-store');
      res.json({ success: false, error: { code: 'NOT_FOUND', message: 'No image uploaded' } });
      return;
    }
    const etag = `"${a.sha256.slice(0, 32)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', v && a.sha256.startsWith(v) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The web app (another origin) shows these in <img>; an SVG opened directly can't run anything.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    if (res.req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', a.contentType);
    res.setHeader('Content-Length', String(a.sizeBytes));
    res.end(Buffer.from(a.bytes));
  }

  @Put()
  @ApiBearerAuth()
  @RequirePermissions('system.settings.manage')
  @ApiOperation({ summary: 'Save the brand (names, colour, contact, sign-in text)' })
  @ApiZodBody(saveBrandSchema)
  save(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(saveBrandSchema)) body: z.output<typeof saveBrandSchema>) {
    return this.settings.save(actor, body);
  }

  @Post('assets/:kind')
  @ApiBearerAuth()
  @RequirePermissions('system.settings.manage')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: BRAND_IMAGE_MAX_BYTES + 1, files: 1, fields: 2 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a logo or icon (PNG, JPEG, WebP, SVG or ICO; at most 1 MB)' })
  upload(@CurrentActor() actor: Actor, @Param('kind', kindPipe) kind: Kind, @Body(new ZodValidationPipe(brandAssetReasonSchema)) body: z.output<typeof brandAssetReasonSchema>, @UploadedFile() file: { buffer: Buffer; size: number } | undefined) {
    return this.settings.upload(actor, kind, file, body.reason);
  }

  @Post('assets/:kind/remove')
  @HttpCode(200)
  @ApiBearerAuth()
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(brandAssetReasonSchema)
  remove(@CurrentActor() actor: Actor, @Param('kind', kindPipe) kind: Kind, @Body(new ZodValidationPipe(brandAssetReasonSchema)) body: z.output<typeof brandAssetReasonSchema>) {
    return this.settings.remove(actor, kind, body.reason);
  }
}

/** A reseller's / API partner's own white-label brand and custom domain (docs/BRANDING.md §5). */
@ApiTags('Brand')
@ApiBearerAuth()
@Controller('v1/reseller/brand')
export class ResellerBrandController {
  constructor(private readonly resellers: ResellerBrandService) {}

  @Get()
  @RequirePermissions('brand.manage')
  get(@CurrentActor() actor: Actor) {
    return this.resellers.get(actor);
  }

  @Put()
  @RequirePermissions('brand.manage')
  @ApiZodBody(saveResellerBrandSchema)
  save(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(saveResellerBrandSchema)) body: z.output<typeof saveResellerBrandSchema>) {
    return this.resellers.save(actor, body);
  }

  @Post('assets/:kind')
  @RequirePermissions('brand.manage')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: BRAND_IMAGE_MAX_BYTES + 1, files: 1, fields: 0 } }))
  @ApiConsumes('multipart/form-data')
  upload(@CurrentActor() actor: Actor, @Param('kind', kindPipe) kind: Kind, @UploadedFile() file: { buffer: Buffer; size: number } | undefined) {
    return this.resellers.upload(actor, kind, file);
  }

  @Post('assets/:kind/remove')
  @HttpCode(200)
  @RequirePermissions('brand.manage')
  removeAsset(@CurrentActor() actor: Actor, @Param('kind', kindPipe) kind: Kind) {
    return this.resellers.removeAsset(actor, kind);
  }

  @Post('domain')
  @HttpCode(200)
  @RequireStepUp()
  @RequirePermissions('brand.manage')
  @ApiOperation({ summary: 'Set a custom domain; returns the DNS TXT record that proves you own it' })
  @ApiZodBody(customDomainSchema)
  setDomain(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(customDomainSchema)) body: z.output<typeof customDomainSchema>) {
    return this.resellers.setDomain(actor, body.domain);
  }

  @Post('domain/verify')
  @HttpCode(200)
  @RequirePermissions('brand.manage')
  @ApiOperation({ summary: 'Check the DNS TXT record now' })
  verifyDomain(@CurrentActor() actor: Actor) {
    return this.resellers.verifyDomain(actor);
  }

  @Post('domain/remove')
  @HttpCode(200)
  @RequireStepUp()
  @RequirePermissions('brand.manage')
  removeDomain(@CurrentActor() actor: Actor) {
    return this.resellers.removeDomain(actor);
  }
}
