import { Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequestContextStore } from '../../common/context/request-context';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { Public } from '../access/decorators';
import { InboundEventsService } from './inbound-events.service';

/** Inbound provider callbacks (signature verified over the raw bytes). */
@ApiExcludeController()
@Controller('v1/webhooks/providers')
export class ProviderWebhooksController {
  constructor(
    private readonly inbound: InboundEventsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Public()
  @Post(':code')
  @HttpCode(200)
  async receive(@Param('code') code: string, @Req() req: Request & { rawBody?: Buffer }, @Headers() headers: Record<string, string | undefined>) {
    await this.rateLimit.enforce({ name: 'provider-webhook', limit: 600, windowSeconds: 60 }, `${code}:${RequestContextStore.get()?.ipAddress ?? '?'}`);
    return this.inbound.receive(code, req.rawBody, headers);
  }
}
