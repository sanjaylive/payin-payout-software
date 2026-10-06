import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { assignPricingPlanSchema, createPricingPlanSchema, idSchema, pricingQuoteSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { MerchantAccessService } from '../merchants/merchant-access.service';
import { PricingService } from './pricing.service';

@ApiTags('Pricing')
@ApiBearerAuth()
@Controller('v1/pricing')
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly merchants: MerchantAccessService,
  ) {}

  @Get('plans')
  @RequirePermissions('pricing.read')
  plans(@CurrentActor() actor: Actor) {
    return this.pricing.listPlans(actor);
  }

  @Post('plans')
  @RequirePermissions('pricing.manage')
  @ApiOperation({ summary: 'Create a rate card (pricing changes are new plans; old snapshots never change)' })
  @ApiZodBody(createPricingPlanSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createPricingPlanSchema)) body: z.output<typeof createPricingPlanSchema>) {
    return this.pricing.createPlan(actor, body);
  }

  @Post('plans/:id/archive')
  @HttpCode(200)
  @RequirePermissions('pricing.manage')
  archive(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(idSchema('ppl'))) id: string) {
    return this.pricing.archivePlan(actor, id);
  }

  @Post('assignments')
  @RequirePermissions('pricing.manage')
  @ApiZodBody(assignPricingPlanSchema)
  assign(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(assignPricingPlanSchema)) body: z.output<typeof assignPricingPlanSchema>) {
    return this.pricing.assign(actor, body);
  }

  @Post('quote')
  @HttpCode(200)
  @RequirePermissions('pricing.read')
  @ApiOperation({ summary: 'Preview fees and margins for a hypothetical transaction' })
  @ApiZodBody(pricingQuoteSchema)
  async quote(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(pricingQuoteSchema)) body: z.output<typeof pricingQuoteSchema>) {
    await this.merchants.require(actor, body.merchant_id);
    return this.pricing.presentQuote(await this.pricing.quote({ merchantId: body.merchant_id, service: body.service, method: body.method, providerId: body.provider_id ?? null, amountMinor: body.amount }));
  }
}
