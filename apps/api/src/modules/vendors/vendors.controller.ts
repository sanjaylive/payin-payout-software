import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createMessagingServiceSchema,
  createVendorSchema,
  idSchema,
  linkProviderSchema,
  messagingSecretSchema,
  testMessageSchema,
  updateMessagingServiceSchema,
  updateVendorSchema,
} from '@pay2all/validation';
import type { z } from 'zod';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions, RequireStepUp } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { VendorsService } from './vendors.service';

const vendorId = new ZodValidationPipe(idSchema('avd'));
const serviceId = new ZodValidationPipe(idSchema('msv'));

@ApiTags('API vendors')
@ApiBearerAuth()
@Controller('v1')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get('vendors')
  @RequirePermissions('provider.read')
  list(@CurrentActor() actor: Actor) {
    return this.vendors.list(actor);
  }

  @Post('vendors')
  @RequirePermissions('provider.manage')
  @ApiZodBody(createVendorSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createVendorSchema)) body: z.output<typeof createVendorSchema>) {
    return this.vendors.create(actor, body);
  }

  @Get('vendors/:id')
  @RequirePermissions('provider.read')
  get(@CurrentActor() actor: Actor, @Param('id', vendorId) id: string) {
    return this.vendors.get(actor, id);
  }

  @Patch('vendors/:id')
  @RequirePermissions('provider.manage')
  @ApiZodBody(updateVendorSchema)
  update(@CurrentActor() actor: Actor, @Param('id', vendorId) id: string, @Body(new ZodValidationPipe(updateVendorSchema)) body: z.output<typeof updateVendorSchema>) {
    return this.vendors.update(actor, id, body);
  }

  @Post('vendors/:id/payment-services')
  @HttpCode(200)
  @RequirePermissions('provider.manage')
  @ApiOperation({ summary: 'Move a payment service (provider) under this vendor' })
  @ApiZodBody(linkProviderSchema)
  link(@CurrentActor() actor: Actor, @Param('id', vendorId) id: string, @Body(new ZodValidationPipe(linkProviderSchema)) body: z.output<typeof linkProviderSchema>) {
    return this.vendors.linkProvider(actor, id, body.provider_id);
  }

  @Post('vendors/:id/messaging-services')
  @RequirePermissions('provider.manage')
  @ApiOperation({ summary: 'Add an SMS / WhatsApp / email service (starts disabled)' })
  @ApiZodBody(createMessagingServiceSchema)
  createService(@CurrentActor() actor: Actor, @Param('id', vendorId) id: string, @Body(new ZodValidationPipe(createMessagingServiceSchema)) body: z.output<typeof createMessagingServiceSchema>) {
    return this.vendors.createService(actor, id, body);
  }

  @Get('messaging-routing')
  @RequirePermissions('provider.read')
  @ApiOperation({ summary: 'Active messaging services per channel, in fallback order' })
  routing(@CurrentActor() actor: Actor) {
    return this.vendors.routing(actor);
  }

  @Patch('messaging-services/:id')
  @RequirePermissions('provider.manage')
  @ApiZodBody(updateMessagingServiceSchema)
  updateService(@CurrentActor() actor: Actor, @Param('id', serviceId) id: string, @Body(new ZodValidationPipe(updateMessagingServiceSchema)) body: z.output<typeof updateMessagingServiceSchema>) {
    return this.vendors.updateService(actor, id, body);
  }

  @Put('messaging-services/:id/credentials')
  @RequireStepUp()
  @RequirePermissions('provider.manage')
  @ApiOperation({ summary: 'Set credentials (write-only; encrypted; audited)' })
  @ApiZodBody(messagingSecretSchema)
  setSecret(@CurrentActor() actor: Actor, @Param('id', serviceId) id: string, @Body(new ZodValidationPipe(messagingSecretSchema)) body: z.output<typeof messagingSecretSchema>) {
    return this.vendors.setSecret(actor, id, body);
  }

  @Post('messaging-services/:id/test')
  @HttpCode(202)
  @RequirePermissions('provider.manage')
  @ApiOperation({ summary: 'Queue a test message through exactly this service' })
  @ApiZodBody(testMessageSchema)
  test(@CurrentActor() actor: Actor, @Param('id', serviceId) id: string, @Body(new ZodValidationPipe(testMessageSchema)) body: z.output<typeof testMessageSchema>) {
    return this.vendors.sendTest(actor, id, body);
  }

  @Get('messaging-services/:id/notifications')
  @RequirePermissions('provider.read')
  notifications(@CurrentActor() actor: Actor, @Param('id', serviceId) id: string) {
    return this.vendors.recentNotifications(actor, id);
  }
}
