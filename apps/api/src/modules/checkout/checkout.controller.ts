import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { addWebsiteSchema, checkoutPaySchema, checkoutSessionIdSchema, checkoutTokenSchema, createCheckoutSessionSchema, idSchema, listCheckoutSessionsQuerySchema, reviewWebsiteSchema } from '@pay2all/validation';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequestContextStore } from '../../common/context/request-context';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ApiZodBody } from '../../common/swagger/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiKeyAccess, CurrentActor, Public, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';
import { CheckoutService } from './checkout.service';

const sessionId = new ZodValidationPipe(checkoutSessionIdSchema);
const websiteId = new ZodValidationPipe(idSchema('web'));
const paymentId = new ZodValidationPipe(idSchema('pay'));
const token = new ZodValidationPipe(checkoutTokenSchema);

@ApiTags('Checkout')
@ApiBearerAuth()
@Controller('v1/checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post('sessions')
  @ApiKeyAccess()
  @RequirePermissions('payin.create')
  @ApiOperation({ summary: 'Create a hosted checkout for an order; send the customer to `url`' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiZodBody(createCheckoutSessionSchema)
  create(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(createCheckoutSessionSchema)) body: z.output<typeof createCheckoutSessionSchema>, @Req() req: Request, @Headers('idempotency-key') key?: string) {
    return this.checkout.createSession(actor, body, req.body, key);
  }

  @Get('sessions')
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  list(@CurrentActor() actor: Actor, @Query(new ZodValidationPipe(listCheckoutSessionsQuerySchema)) q: z.output<typeof listCheckoutSessionsQuerySchema>) {
    return this.checkout.listSessions(actor, q);
  }

  @Get('sessions/:id')
  @ApiKeyAccess()
  @RequirePermissions('payin.read')
  @ApiOperation({ summary: 'A checkout and its payment — use this (not the return URL) to confirm an order is paid' })
  get(@CurrentActor() actor: Actor, @Param('id', sessionId) id: string) {
    return this.checkout.getSession(actor, id);
  }

  @Post('sessions/:id/cancel')
  @ApiKeyAccess()
  @HttpCode(200)
  @RequirePermissions('payin.create')
  cancel(@CurrentActor() actor: Actor, @Param('id', sessionId) id: string) {
    return this.checkout.cancelSession(actor, id);
  }

  @Get('websites')
  @RequirePermissions('api_key.read')
  websites(@CurrentActor() actor: Actor) {
    return this.checkout.websites(actor);
  }

  @Post('websites')
  @RequirePermissions('api_key.manage')
  @ApiOperation({ summary: 'Add a website (Pay2All reviews it before checkout can return customers there)' })
  @ApiZodBody(addWebsiteSchema)
  addWebsite(@CurrentActor() actor: Actor, @Body(new ZodValidationPipe(addWebsiteSchema)) body: z.output<typeof addWebsiteSchema>) {
    return this.checkout.addWebsite(actor, body);
  }

  @Post('websites/:id/remove')
  @HttpCode(200)
  @RequirePermissions('api_key.manage')
  removeWebsite(@CurrentActor() actor: Actor, @Param('id', websiteId) id: string) {
    return this.checkout.removeWebsite(actor, id);
  }

  // Gateway hand-off and return: the customer's browser, not our API clients.

  @Public()
  @Get('return/:paymentId')
  @ApiExcludeEndpoint()
  async returnGet(@Param('paymentId', paymentId) id: string, @Res() res: Response) {
    res.redirect(303, await this.checkout.handleReturn(id));
  }

  @Public()
  @Post('return/:paymentId')
  @ApiExcludeEndpoint()
  async returnPost(@Param('paymentId', paymentId) id: string, @Res() res: Response) {
    // Form-posting gateways (CCAvenue, Easebuzz, NTT DATA) land here; the body is never trusted.
    res.redirect(303, await this.checkout.handleReturn(id));
  }

  @Public()
  @Get('pay/:paymentId')
  @ApiExcludeEndpoint()
  async handoff(@Param('paymentId', paymentId) id: string, @Res() res: Response) {
    const r = await this.checkout.handoff(id);
    if ('redirect' in r) return res.redirect(303, r.redirect);
    res.setHeader('Content-Security-Policy', r.csp);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.status(r.status).type('html').send(r.html);
  }
}

/** The customer-facing checkout page's API: unauthenticated, addressed by the session's random token. */
@ApiTags('Checkout')
@Controller('v1/public/checkout')
export class PublicCheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private limit(name: string, tokenValue: string, per: number) {
    const ip = RequestContextStore.get()?.ipAddress ?? '?';
    return Promise.all([this.rateLimit.enforce({ name: `checkout-${name}`, limit: per, windowSeconds: 60 }, `${tokenValue}:${ip}`), this.rateLimit.enforce({ name: 'checkout-ip', limit: 300, windowSeconds: 60 }, ip)]);
  }

  @Public()
  @Get(':token')
  @ApiExcludeEndpoint()
  async view(@Param('token', token) t: string) {
    await this.limit('view', t, 60);
    return this.checkout.view(t);
  }

  @Public()
  @Get(':token/status')
  @ApiExcludeEndpoint()
  async status(@Param('token', token) t: string) {
    await this.limit('status', t, 120);
    return this.checkout.status(t);
  }

  @Public()
  @Post(':token/pay')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async pay(@Param('token', token) t: string, @Body(new ZodValidationPipe(checkoutPaySchema)) body: z.output<typeof checkoutPaySchema>) {
    await this.limit('pay', t, 10);
    return this.checkout.pay(t, body);
  }

  @Public()
  @Post(':token/cancel')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async cancel(@Param('token', token) t: string) {
    await this.limit('cancel', t, 10);
    return this.checkout.cancelByCustomer(t);
  }
}

/** Platform: review merchants' websites. */
@ApiTags('Checkout')
@ApiBearerAuth()
@Controller('v1/admin/websites')
export class AdminWebsitesController {
  constructor(private readonly checkout: CheckoutService) {}

  @Get()
  @RequirePermissions('merchant.read')
  list(@CurrentActor() actor: Actor, @Query('status') status?: string, @Query('merchant_id') merchantId?: string) {
    const st = z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional().parse(status || undefined);
    const mid = idSchema('org').optional().parse(merchantId || undefined);
    return this.checkout.reviewQueue(actor, st, mid);
  }

  @Post(':id/review')
  @HttpCode(200)
  @RequirePermissions('compliance.approve')
  @ApiZodBody(reviewWebsiteSchema)
  review(@CurrentActor() actor: Actor, @Param('id', websiteId) id: string, @Body(new ZodValidationPipe(reviewWebsiteSchema)) body: z.output<typeof reviewWebsiteSchema>) {
    return this.checkout.reviewWebsite(actor, id, body);
  }
}
