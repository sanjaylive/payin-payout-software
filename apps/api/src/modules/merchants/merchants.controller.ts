import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createMerchantSchema,
  idSchema,
  listMerchantsQuerySchema,
  merchantBankAccountSchema,
  merchantPersonSchema,
  merchantProfileSchema,
} from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { MerchantPartiesService } from './merchant-parties.service';
import { MerchantsService } from './merchants.service';

export const merchantIdPipe = new ZodValidationPipe(idSchema('org'));
const personIdPipe = new ZodValidationPipe(idSchema('mpr'));
const accountIdPipe = new ZodValidationPipe(idSchema('mba'));

@ApiTags('Merchants')
@ApiBearerAuth()
@Controller('v1/merchants')
export class MerchantsController {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly parties: MerchantPartiesService,
  ) {}

  @Post()
  @RequirePermissions('merchant.create')
  @ApiOperation({ summary: 'Create a merchant account (platform staff or reseller)' })
  @ApiZodBody(createMerchantSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createMerchantSchema)) body: z.output<typeof createMerchantSchema>) {
    return this.merchants.create(actor, body);
  }

  @Get()
  @RequirePermissions('merchant.read')
  @ApiOperation({ summary: 'List merchants in scope (status may be a comma-separated list)' })
  @ApiZodQuery(listMerchantsQuerySchema)
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listMerchantsQuerySchema)) query: z.output<typeof listMerchantsQuerySchema>) {
    return this.merchants.list(actor, query);
  }

  @Get(':merchantId')
  @RequirePermissions('merchant.read')
  @ApiOperation({ summary: 'Full onboarding application with requirements checklist' })
  get(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) merchantId: string) {
    return this.merchants.get(actor, merchantId);
  }

  @Patch(':merchantId/profile')
  @RequirePermissions('merchant.update')
  @ApiOperation({ summary: 'Save business profile fields (draft; partial updates allowed)' })
  @ApiZodBody(merchantProfileSchema)
  updateProfile(
    @CurrentActor() actor: Actor,
    @Param('merchantId', merchantIdPipe) merchantId: string,
    @Body(new ZodValidationPipe(merchantProfileSchema)) body: z.output<typeof merchantProfileSchema>,
  ) {
    return this.merchants.updateProfile(actor, merchantId, body);
  }

  @Post(':merchantId/persons')
  @RequirePermissions('merchant.update')
  @ApiZodBody(merchantPersonSchema)
  addPerson(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) merchantId: string, @Body(new ZodValidationPipe(merchantPersonSchema)) body: z.output<typeof merchantPersonSchema>) {
    return this.parties.addPerson(actor, merchantId, body);
  }

  @Patch(':merchantId/persons/:personId')
  @RequirePermissions('merchant.update')
  @ApiZodBody(merchantPersonSchema)
  updatePerson(
    @CurrentActor() actor: Actor,
    @Param('merchantId', merchantIdPipe) merchantId: string,
    @Param('personId', personIdPipe) personId: string,
    @Body(new ZodValidationPipe(merchantPersonSchema)) body: z.output<typeof merchantPersonSchema>,
  ) {
    return this.parties.updatePerson(actor, merchantId, personId, body);
  }

  @Delete(':merchantId/persons/:personId')
  @RequirePermissions('merchant.update')
  removePerson(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) merchantId: string, @Param('personId', personIdPipe) personId: string) {
    return this.parties.removePerson(actor, merchantId, personId);
  }

  @Post(':merchantId/bank-accounts')
  @RequireStepUp()
  @RequirePermissions('merchant.update')
  @ApiOperation({ summary: 'Add a settlement bank account (number is encrypted; only a masked copy is returned)' })
  @ApiZodBody(merchantBankAccountSchema)
  addBankAccount(
    @CurrentActor() actor: Actor,
    @Param('merchantId', merchantIdPipe) merchantId: string,
    @Body(new ZodValidationPipe(merchantBankAccountSchema)) body: z.output<typeof merchantBankAccountSchema>,
  ) {
    return this.parties.addBankAccount(actor, merchantId, body);
  }

  @Post(':merchantId/bank-accounts/:accountId/primary')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('merchant.update')
  setPrimary(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) merchantId: string, @Param('accountId', accountIdPipe) accountId: string) {
    return this.parties.setPrimaryBankAccount(actor, merchantId, accountId);
  }

  @Delete(':merchantId/bank-accounts/:accountId')
  @RequirePermissions('merchant.update')
  deactivate(@CurrentActor() actor: Actor, @Param('merchantId', merchantIdPipe) merchantId: string, @Param('accountId', accountIdPipe) accountId: string) {
    return this.parties.deactivateBankAccount(actor, merchantId, accountId);
  }
}
