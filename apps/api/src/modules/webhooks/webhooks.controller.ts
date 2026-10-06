import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createWebhookEndpointSchema, idSchema, listWebhookDeliveriesQuerySchema, listWebhookEventsQuerySchema, updateWebhookEndpointSchema } from '@pay2all/validation';
import { z } from 'zod';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { ApiZodBody, ApiZodQuery } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { WebhooksService } from './webhooks.service';

const endpointIdPipe = new ZodValidationPipe(idSchema('whe'));
const deliveryIdPipe = new ZodValidationPipe(idSchema('whd'));

const platformOnly = (actor: Actor) => {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
};

@ApiTags('Webhooks')
@ApiBearerAuth()
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('endpoints')
  @RequirePermissions('webhook.manage')
  @ApiOperation({ summary: 'Add an endpoint. The signing secret is returned once — store it now.' })
  @ApiZodBody(createWebhookEndpointSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createWebhookEndpointSchema)) body: z.output<typeof createWebhookEndpointSchema>) {
    return this.webhooks.create(actor, body);
  }

  @Get('endpoints')
  @RequirePermissions('webhook.read')
  list(@CurrentActor() actor: Actor) {
    return this.webhooks.list(actor);
  }

  @Patch('endpoints/:id')
  @RequirePermissions('webhook.manage')
  @ApiZodBody(updateWebhookEndpointSchema)
  update(@CurrentActor() actor: Actor, @Param('id', endpointIdPipe) id: string, @Body(new ZodValidationPipe(updateWebhookEndpointSchema)) body: z.output<typeof updateWebhookEndpointSchema>) {
    return this.webhooks.update(actor, id, body);
  }

  @Post('endpoints/:id/rotate-secret')
  @HttpCode(200)
  @RequirePermissions('webhook.manage')
  @ApiOperation({ summary: 'Issue a new signing secret (returned once); the old one stops working immediately.' })
  rotate(@CurrentActor() actor: Actor, @Param('id', endpointIdPipe) id: string) {
    return this.webhooks.rotateSecret(actor, id);
  }

  @Post('endpoints/:id/test')
  @HttpCode(202)
  @RequirePermissions('webhook.manage')
  test(@CurrentActor() actor: Actor, @Param('id', endpointIdPipe) id: string) {
    return this.webhooks.sendTest(actor, id);
  }

  @Get('events')
  @RequirePermissions('webhook.read')
  @ApiZodQuery(listWebhookEventsQuerySchema)
  events(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listWebhookEventsQuerySchema)) q: z.output<typeof listWebhookEventsQuerySchema>) {
    return this.webhooks.listEvents(actor, q);
  }

  @Get('deliveries')
  @RequirePermissions('webhook.read')
  @ApiZodQuery(listWebhookDeliveriesQuerySchema)
  deliveries(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listWebhookDeliveriesQuerySchema)) q: z.output<typeof listWebhookDeliveriesQuerySchema>) {
    return this.webhooks.listDeliveries(actor, q);
  }

  @Get('deliveries/:id')
  @RequirePermissions('webhook.read')
  delivery(@CurrentActor() actor: Actor, @Param('id', deliveryIdPipe) id: string) {
    return this.webhooks.getDelivery(actor, id);
  }

  @Post('deliveries/:id/retry')
  @HttpCode(200)
  @RequirePermissions('webhook.manage')
  retry(@CurrentActor() actor: Actor, @Param('id', deliveryIdPipe) id: string) {
    return this.webhooks.retry(actor, id);
  }
}

@ApiTags('Event pipeline')
@ApiBearerAuth()
@Controller('v1/system/events')
export class EventPipelineController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('health')
  @RequirePermissions('webhook.read')
  @ApiOperation({ summary: 'Platform: outbox backlog, dead letters, webhook and notification queues' })
  health(@CurrentActor() actor: Actor) {
    platformOnly(actor);
    return this.webhooks.pipelineHealth();
  }

  @Get('dead-letters')
  @RequirePermissions('webhook.read')
  deadLetters(@CurrentActor() actor: Actor, @Query('open') open?: string) {
    platformOnly(actor);
    return this.webhooks.listDeadLetters(open !== 'false');
  }

  @Post('dead-letters/:id/requeue')
  @HttpCode(200)
  @RequirePermissions('webhook.manage')
  requeue(@CurrentActor() actor: Actor, @Param('id', new ZodValidationPipe(idSchema('dlq'))) id: string) {
    platformOnly(actor);
    return this.webhooks.requeueDeadLetter(actor, id);
  }
}
