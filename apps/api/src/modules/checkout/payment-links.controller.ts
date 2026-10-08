import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createPaymentLinkSchema,
  listPaymentLinksQuerySchema,
  notifyPaymentLinkSchema,
  pageSlugSchema,
  paymentLinkIdSchema,
  paymentPageIdSchema,
  paymentPageStatusSchema,
  savePaymentPageSchema,
  startPagePaymentSchema,
} from '@pay2all/validation';
import type { Request } from 'express';
import type { z } from 'zod';
import { RequestContextStore } from '../../common/context/request-context';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiKeyAccess, CurrentActor, Public, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { PaymentLinksService } from './payment-links.service';
import { PaymentPagesService } from './payment-pages.service';

const linkId = new ZodValidationPipe(paymentLinkIdSchema);
const pageId = new ZodValidationPipe(paymentPageIdSchema);

@ApiTags('Payment links')
@ApiBearerAuth()
@Controller('v1/payment-links')
export class PaymentLinksController {
  constructor(private readonly links: PaymentLinksService) {}

  @Post()
  @ApiKeyAccess()
  @RequirePermissions('payin.create')
  @ApiOperation({ summary: 'Create a payment link (optionally email / SMS it to the customer)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiZodBody(createPaymentLinkSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createPaymentLinkSchema)) body: z.output<typeof createPaymentLinkSchema>, @Req() req: Request, @Headers('idempotency-key') key?: string) {
    return this.links.create(actor, body, req.body, key);
  }

  @Get()
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  @ApiOperation({ summary: 'List payment links' })
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listPaymentLinksQuerySchema)) q: z.output<typeof listPaymentLinksQuerySchema>) {
    return this.links.list(actor, q);
  }

  @Get('summary')
  @RequirePermissions('payin.read')
  @ApiOperation({ summary: 'Payment link totals for the last 30 days' })
  summary(@CurrentActor() actor: Actor) {
    return this.links.summary(actor);
  }

  @Get(':id')
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  @ApiOperation({ summary: 'Retrieve a payment link and its latest payment' })
  get(@CurrentActor() actor: Actor, @Param('id', linkId) id: string) {
    return this.links.get(actor, id);
  }

  @Post(':id/cancel')
  @ApiKeyAccess()
  @HttpCode(200)
  @RequirePermissions('payin.create')
  @ApiOperation({ summary: 'Cancel an unpaid payment link' })
  cancel(@CurrentActor() actor: Actor, @Param('id', linkId) id: string) {
    return this.links.cancel(actor, id);
  }

  @Post(':id/notify')
  @ApiKeyAccess()
  @HttpCode(200)
  @RequirePermissions('payin.create')
  @ApiOperation({ summary: 'Send (or resend) the link to the customer by email and/or SMS' })
  @ApiZodBody(notifyPaymentLinkSchema)
  notify(@CurrentActor() actor: Actor, @Param('id', linkId) id: string, @Body(new ZodValidationPipe(notifyPaymentLinkSchema)) body: z.output<typeof notifyPaymentLinkSchema>) {
    return this.links.notify(actor, id, body);
  }
}

@ApiTags('Payment pages')
@ApiBearerAuth()
@Controller('v1/payment-pages')
export class PaymentPagesController {
  constructor(private readonly pages: PaymentPagesService) {}

  @Get()
  @RequirePermissions('payin.read')
  @ApiOperation({ summary: 'Your payment pages with payment totals' })
  list(@CurrentActor() actor: Actor) {
    return this.pages.list(actor);
  }

  @Post()
  @RequirePermissions('payin.create')
  @ApiOperation({ summary: 'Create a payment page (/p/<slug>)' })
  @ApiZodBody(savePaymentPageSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(savePaymentPageSchema)) body: z.output<typeof savePaymentPageSchema>) {
    return this.pages.create(actor, body);
  }

  @Get(':id')
  @RequirePermissions('payin.read')
  get(@CurrentActor() actor: Actor, @Param('id', pageId) id: string) {
    return this.pages.get(actor, id);
  }

  @Put(':id')
  @RequirePermissions('payin.create')
  @ApiZodBody(savePaymentPageSchema)
  update(@CurrentActor() actor: Actor, @Param('id', pageId) id: string, @Body(new ZodValidationPipe(savePaymentPageSchema)) body: z.output<typeof savePaymentPageSchema>) {
    return this.pages.update(actor, id, body);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('payin.create')
  @ApiZodBody(paymentPageStatusSchema)
  status(@CurrentActor() actor: Actor, @Param('id', pageId) id: string, @Body(new ZodValidationPipe(paymentPageStatusSchema)) body: z.output<typeof paymentPageStatusSchema>) {
    return this.pages.setStatus(actor, id, body.status);
  }

  @Get(':id/payments')
  @RequirePermissions('payin.read')
  @ApiOperation({ summary: 'Payments made through a page, with the payers’ answers' })
  payments(@CurrentActor() actor: Actor, @Param('id', pageId) id: string) {
    return this.pages.payments(actor, id);
  }
}

/** /p/<slug>: unauthenticated, rate-limited per IP. */
@ApiTags('Payment pages')
@Controller('v1/public/pages')
export class PublicPaymentPagesController {
  constructor(
    private readonly pages: PaymentPagesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private limit(name: string, per: number) {
    const ip = RequestContextStore.get()?.ipAddress ?? '?';
    return this.rateLimit.enforce({ name: `page-${name}`, limit: per, windowSeconds: 60 }, ip);
  }

  @Public()
  @Get(':slug')
  @ApiExcludeEndpoint()
  async view(@Param('slug', new ZodValidationPipe(pageSlugSchema)) slug: string) {
    await this.limit('view', 120);
    return this.pages.publicView(slug);
  }

  @Public()
  @Post(':slug/checkout')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async start(@Param('slug', new ZodValidationPipe(pageSlugSchema)) slug: string, @Body(new ZodValidationPipe(startPagePaymentSchema)) body: z.output<typeof startPagePaymentSchema>) {
    await this.limit('start', 10);
    return this.pages.start(slug, body);
  }
}
