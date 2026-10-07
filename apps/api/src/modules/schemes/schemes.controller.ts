import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  archiveSchemeSchema,
  assignSchemeSchema,
  idSchema,
  pricingProviderIdSchema,
  pricingProviderSchema,
  removePricingProviderSchema,
  saveSchemeSchema,
  schemeMerchantsQuerySchema,
  schemePreviewSchema,
  setDefaultSchemeSchema,
} from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { SchemesService } from './schemes.service';

const schemeId = new ZodValidationPipe(idSchema('sch'));
const merchantId = new ZodValidationPipe(idSchema('org'));
const providerId = new ZodValidationPipe(pricingProviderIdSchema);

@ApiTags('Pricing schemes')
@ApiBearerAuth()
@Controller('v1')
export class SchemesController {
  constructor(private readonly schemes: SchemesService) {}

  // Pricing providers: numbered pricing lines, managed by super admins in Settings.

  @Get('pricing-providers')
  @RequirePermissions('pricing.read')
  providers(@CurrentActor() actor: Actor) {
    return this.schemes.listProviders(actor);
  }

  @Post('pricing-providers')
  @RequirePermissions('system.settings.manage')
  @ApiOperation({ summary: 'Add a pricing provider (e.g. 4 = Virtual account)' })
  @ApiZodBody(pricingProviderSchema)
  createProvider(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(pricingProviderSchema)) body: z.output<typeof pricingProviderSchema>) {
    return this.schemes.createProvider(actor, body);
  }

  @Put('pricing-providers/:id')
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(pricingProviderSchema)
  updateProvider(@CurrentActor() actor: Actor, @Param('id', providerId) id: number, @Body(new ZodValidationPipe(pricingProviderSchema)) body: z.output<typeof pricingProviderSchema>) {
    return this.schemes.updateProvider(actor, id, body);
  }

  @Post('pricing-providers/:id/remove')
  @HttpCode(200)
  @RequirePermissions('system.settings.manage')
  @ApiZodBody(removePricingProviderSchema)
  removeProvider(@CurrentActor() actor: Actor, @Param('id', providerId) id: number, @Body(new ZodValidationPipe(removePricingProviderSchema)) body: z.output<typeof removePricingProviderSchema>) {
    return this.schemes.removeProvider(actor, id, body.reason);
  }

  // Schemes.

  @Get('schemes')
  @RequirePermissions('pricing.read')
  list(@CurrentActor() actor: Actor) {
    return this.schemes.list(actor);
  }

  @Post('schemes')
  @RequirePermissions('pricing.manage')
  @ApiOperation({ summary: 'Create a scheme: per provider, amount slabs with a value (negative = charge, positive = commission), % or flat' })
  @ApiZodBody(saveSchemeSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(saveSchemeSchema)) body: z.output<typeof saveSchemeSchema>) {
    return this.schemes.create(actor, body);
  }

  @Post('schemes/default')
  @HttpCode(200)
  @RequirePermissions('pricing.manage')
  @ApiOperation({ summary: 'Choose the scheme merchants join by default (null = none)' })
  @ApiZodBody(setDefaultSchemeSchema)
  setDefault(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(setDefaultSchemeSchema)) body: z.output<typeof setDefaultSchemeSchema>) {
    return this.schemes.setDefault(actor, body.scheme_id, body.reason);
  }

  @Post('schemes/assign')
  @HttpCode(200)
  @RequirePermissions('pricing.manage')
  @ApiOperation({ summary: 'Put merchants (chosen, or all) on a scheme, or back on the default' })
  @ApiZodBody(assignSchemeSchema)
  assign(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(assignSchemeSchema)) body: z.output<typeof assignSchemeSchema>) {
    return this.schemes.assign(actor, body);
  }

  @Post('schemes/preview')
  @HttpCode(200)
  @RequirePermissions('pricing.read')
  @ApiOperation({ summary: 'Fee or commission a transaction would get' })
  @ApiZodBody(schemePreviewSchema)
  preview(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(schemePreviewSchema)) body: z.output<typeof schemePreviewSchema>) {
    return this.schemes.preview(actor, body);
  }

  @Get('schemes/merchants')
  @RequirePermissions('pricing.read', 'merchant.read')
  merchants(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(schemeMerchantsQuerySchema)) query: z.output<typeof schemeMerchantsQuerySchema>) {
    return this.schemes.merchants(actor, query);
  }

  @Get('schemes/merchants/:merchantId')
  @RequirePermissions('pricing.read', 'merchant.read')
  merchantPricing(@CurrentActor() actor: Actor, @Param('merchantId', merchantId) id: string) {
    return this.schemes.merchantPricing(actor, id);
  }

  @Get('schemes/:id')
  @RequirePermissions('pricing.read')
  get(@CurrentActor() actor: Actor, @Param('id', schemeId) id: string) {
    return this.schemes.get(actor, id);
  }

  @Put('schemes/:id')
  @RequirePermissions('pricing.manage')
  @ApiZodBody(saveSchemeSchema)
  update(@CurrentActor() actor: Actor, @Param('id', schemeId) id: string, @Body(new ZodValidationPipe(saveSchemeSchema)) body: z.output<typeof saveSchemeSchema>) {
    return this.schemes.update(actor, id, body);
  }

  @Post('schemes/:id/archive')
  @HttpCode(200)
  @RequirePermissions('pricing.manage')
  @ApiZodBody(archiveSchemeSchema)
  archive(@CurrentActor() actor: Actor, @Param('id', schemeId) id: string, @Body(new ZodValidationPipe(archiveSchemeSchema)) body: z.output<typeof archiveSchemeSchema>) {
    return this.schemes.archive(actor, id, body.reason);
  }
}
