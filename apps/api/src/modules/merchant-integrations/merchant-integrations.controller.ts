import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createWebhookEndpointSchema, idSchema, ipAllowlistEntrySchema, updateWebhookEndpointSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import { ApiKeysService } from '../api-keys/api-keys.service';
import type { Actor } from '../auth/actor';
import { WebhooksService } from '../webhooks/webhooks.service';

const merchantId = new ZodValidationPipe(idSchema('org'));
const endpointId = new ZodValidationPipe(idSchema('whe'));
const entryId = new ZodValidationPipe(idSchema('ipa'));

/**
 * Platform staff configuring a merchant's integrations on its behalf (e.g. during onboarding):
 * webhook endpoints and the API IP allowlist. Platform-only (`merchant.integration.manage`);
 * the merchant is always explicit in the path and every change is audited as on-behalf.
 */
@ApiTags('Admin: merchant integrations')
@ApiBearerAuth()
@Controller('v1/admin/merchants/:merchantId')
export class MerchantIntegrationsController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly keys: ApiKeysService,
  ) {}

  @Get('webhook-endpoints')
  @RequirePermissions('webhook.read')
  listEndpoints(@CurrentActor() actor: Actor, @Param('merchantId', merchantId) id: string) {
    return this.webhooks.list(actor, id);
  }

  @Post('webhook-endpoints')
  @RequireStepUp()
  @RequirePermissions('merchant.integration.manage')
  @ApiOperation({ summary: 'Add a webhook endpoint for the merchant (signing secret shown once)' })
  @ApiZodBody(createWebhookEndpointSchema)
  createEndpoint(@CurrentActor() actor: Actor, @Param('merchantId', merchantId) id: string, @Body(new ZodValidationPipe(createWebhookEndpointSchema)) body: z.output<typeof createWebhookEndpointSchema>) {
    return this.webhooks.create(actor, body, id);
  }

  @Patch('webhook-endpoints/:endpointId')
  @RequireStepUp()
  @RequirePermissions('merchant.integration.manage')
  @ApiZodBody(updateWebhookEndpointSchema)
  updateEndpoint(
    @CurrentActor() actor: Actor,
    @Param('merchantId', merchantId) id: string,
    @Param('endpointId', endpointId) endpoint: string,
    @Body(new ZodValidationPipe(updateWebhookEndpointSchema)) body: z.output<typeof updateWebhookEndpointSchema>,
  ) {
    return this.webhooks.update(actor, endpoint, body, id);
  }

  @Post('webhook-endpoints/:endpointId/rotate-secret')
  @RequireStepUp()
  @HttpCode(200)
  @RequirePermissions('merchant.integration.manage')
  rotate(@CurrentActor() actor: Actor, @Param('merchantId', merchantId) id: string, @Param('endpointId', endpointId) endpoint: string) {
    return this.webhooks.rotateSecret(actor, endpoint, id);
  }

  @Post('webhook-endpoints/:endpointId/test')
  @HttpCode(202)
  @RequirePermissions('merchant.integration.manage')
  test(@CurrentActor() actor: Actor, @Param('merchantId', merchantId) id: string, @Param('endpointId', endpointId) endpoint: string) {
    return this.webhooks.sendTest(actor, endpoint, id);
  }

  @Get('ip-allowlist')
  @RequirePermissions('merchant.read')
  listAllowlist(@CurrentActor() actor: Actor, @Param('merchantId', merchantId) id: string) {
    return this.keys.listAllowlist(actor, id);
  }

  @Post('ip-allowlist')
  @RequireStepUp()
  @RequirePermissions('merchant.integration.manage')
  @ApiZodBody(ipAllowlistEntrySchema)
  addAllowlist(@CurrentActor() actor: Actor, @Param('merchantId', merchantId) id: string, @Body(new ZodValidationPipe(ipAllowlistEntrySchema)) body: z.output<typeof ipAllowlistEntrySchema>) {
    return this.keys.addAllowlist(actor, body, id);
  }

  @Delete('ip-allowlist/:entryId')
  @RequireStepUp()
  @RequirePermissions('merchant.integration.manage')
  removeAllowlist(@CurrentActor() actor: Actor, @Param('merchantId', merchantId) id: string, @Param('entryId', entryId) entry: string) {
    return this.keys.removeAllowlist(actor, entry, id);
  }
}
