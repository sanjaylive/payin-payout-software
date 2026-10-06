import { Controller, Headers, HttpCode, Inject, Logger, Param, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { newId } from '@pay2all/auth';
import { isUniqueViolation, type Prisma, type PrismaClient } from '@pay2all/database';
import { ADAPTERS } from '@pay2all/providers';
import { ErrorCode } from '@pay2all/types';
import type { Request } from 'express';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { PRISMA } from '../../infra/tokens';
import { Public } from '../access/decorators';
import { AuditService } from '../audit/audit.service';
import { ProviderRegistryService } from './provider-registry.service';

/**
 * Inbound provider callbacks. Signatures are verified over the exact raw bytes; unverified payloads
 * are never stored. Verified events are de-duplicated on (provider, external event id) and queued
 * for processing (Payin/Payout phases consume them). Always fast — no business work inline.
 */
@ApiExcludeController()
@Controller('v1/webhooks/providers')
export class ProviderWebhooksController {
  private readonly logger = new Logger(ProviderWebhooksController.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: ProviderRegistryService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post(':code')
  @HttpCode(200)
  async receive(@Param('code') code: string, @Req() req: Request & { rawBody?: Buffer }, @Headers() headers: Record<string, string | undefined>) {
    await this.rateLimit.enforce({ name: 'provider-webhook', limit: 600, windowSeconds: 60 }, `${code}:${RequestContextStore.get()?.ipAddress ?? '?'}`);
    const provider = /^[a-z0-9-]{2,40}$/.test(code) ? await this.prisma.provider.findUnique({ where: { code } }) : null;
    if (!provider || !req.rawBody) throw new AppError(ErrorCode.NOT_FOUND);
    const factory = ADAPTERS[provider.adapter];
    const ctx = await this.registry.context(provider);
    const adapter = factory?.payin?.(ctx) ?? factory?.payout?.(ctx);
    if (!adapter) throw new AppError(ErrorCode.NOT_FOUND);

    const verification = adapter.verifyWebhook(req.rawBody, headers);
    if (!verification.valid || !verification.event) {
      this.logger.warn({ provider: code, reason: verification.reason }, 'Rejected provider webhook');
      await this.audit.record({ action: 'provider.webhook.rejected', resourceType: 'provider', resourceId: provider.id, organizationId: null, actor: { type: 'SYSTEM', id: null }, metadata: { reason: verification.reason, severity: 'MEDIUM' } });
      throw new AppError(ErrorCode.INVALID_SIGNATURE, 'Invalid signature');
    }

    const e = verification.event;
    try {
      await this.prisma.providerWebhookEvent.create({
        data: {
          id: newId('providerWebhook'),
          providerId: provider.id,
          externalEventId: e.externalEventId,
          eventType: e.type,
          signatureValid: true,
          payload: JSON.parse(JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Prisma.InputJsonValue,
          requestId: RequestContextStore.get()?.requestId ?? null,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { received: true, duplicate: true };
      throw err;
    }
    return { received: true, duplicate: false };
  }
}
