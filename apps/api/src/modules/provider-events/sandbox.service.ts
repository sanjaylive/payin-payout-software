import { createHmac, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import type { Actor } from '../auth/actor';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { InboundEventsService } from './inbound-events.service';

/**
 * Sandbox "customer pays" simulator. Builds a correctly signed mock-provider callback and feeds it
 * through the real inbound path — so demos exercise exactly the production code. Only for mock
 * providers in the TEST environment, and never in production.
 */
@Injectable()
export class SandboxService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: ProviderRegistryService,
    private readonly inbound: InboundEventsService,
    private readonly scope: TenantScopeService,
    private readonly config: ApiConfig,
  ) {}

  async completePayment(actor: Actor, paymentId: string, outcome: 'SUCCESS' | 'FAILED') {
    if (this.config.isProduction) throw new AppError(ErrorCode.NOT_FOUND);
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const p = await this.prisma.payment.findFirst({ where: { id: paymentId, ...(ids ? { merchantId: { in: ids } } : {}) } });
    if (!p) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
    if (!p.providerId || !p.providerOrderId) throw new AppError(ErrorCode.INVALID_REQUEST, 'Payment has no provider order yet');
    const provider = await this.prisma.provider.findUniqueOrThrow({ where: { id: p.providerId } });
    if (provider.adapter !== 'mock' || provider.environment !== 'TEST') throw new AppError(ErrorCode.FORBIDDEN, 'Simulation is only available for sandbox providers');
    const ctx = await this.registry.context(provider);
    const secret = ctx.credentials.webhook_secret;
    if (!secret) throw new AppError(ErrorCode.INVALID_REQUEST, 'Sandbox provider has no webhook secret');
    const digits = () => String(Math.floor(1e11 + Math.random() * 9e11));
    const body = Buffer.from(
      JSON.stringify({
        event_id: `sbx_${randomUUID()}`,
        type: 'payment.status',
        data: {
          reference: p.id,
          provider_order_id: p.providerOrderId,
          status: outcome,
          amount_minor: p.amountMinor.toString(),
          ...(outcome === 'SUCCESS' ? { utr: digits(), rrn: digits(), payer_vpa: 'sandbox.customer@okmock' } : { failure_reason: 'Customer declined the collect request (sandbox)' }),
        },
      }),
    );
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    return this.inbound.receive(provider.code, body, { 'x-mock-signature': signature });
  }

  /** A customer scans a sandbox static QR and pays `amountMinor` — a signed credit callback. */
  async payStaticQr(actor: Actor, qrId: string, amountMinor: bigint, payerVpa?: string) {
    if (this.config.isProduction) throw new AppError(ErrorCode.NOT_FOUND);
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const q = await this.prisma.staticQr.findFirst({ where: { id: qrId, ...(ids ? { merchantId: { in: ids } } : {}) } });
    if (!q) throw new AppError(ErrorCode.NOT_FOUND, 'QR code not found');
    if (q.status !== 'ACTIVE') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'This QR code is closed');
    const provider = await this.prisma.provider.findUniqueOrThrow({ where: { id: q.providerId } });
    if (provider.adapter !== 'mock' || provider.environment !== 'TEST') throw new AppError(ErrorCode.FORBIDDEN, 'Simulation is only available for sandbox providers');
    const secret = (await this.registry.context(provider)).credentials.webhook_secret;
    if (!secret) throw new AppError(ErrorCode.INVALID_REQUEST, 'Sandbox provider has no webhook secret');
    const digits = () => String(Math.floor(1e11 + Math.random() * 9e11));
    const body = Buffer.from(
      JSON.stringify({
        event_id: `sbx_${randomUUID()}`,
        type: 'static_qr.credit',
        data: { qr_id: q.providerQrId, provider_reference: `mockpay_${randomUUID().replace(/-/g, '').slice(0, 20)}`, status: 'SUCCESS', amount_minor: amountMinor.toString(), utr: digits(), rrn: digits(), payer_vpa: payerVpa ?? 'sandbox.customer@okmock', paid_at: new Date().toISOString() },
      }),
    );
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    return this.inbound.receive(provider.code, body, { 'x-mock-signature': signature });
  }

  /** Simulate the bank's answer for a sent payout (success, failure, or a later bank return). */
  async completePayout(actor: Actor, payoutId: string, outcome: 'SUCCESS' | 'FAILED' | 'REVERSED') {
    if (this.config.isProduction) throw new AppError(ErrorCode.NOT_FOUND);
    const ids = await this.scope.accessibleOrganizationIds(actor);
    const p = await this.prisma.payout.findFirst({ where: { id: payoutId, ...(ids ? { merchantId: { in: ids } } : {}) } });
    if (!p) throw new AppError(ErrorCode.TRANSACTION_NOT_FOUND);
    const attempt = await this.prisma.payoutAttempt.findFirst({ where: { payoutId, status: { in: ['ACCEPTED', 'UNKNOWN', 'INITIATED'] } }, orderBy: { attemptNo: 'desc' } });
    if (!attempt) throw new AppError(ErrorCode.INVALID_REQUEST, 'The payout has not been sent to a provider yet');
    const provider = await this.prisma.provider.findUniqueOrThrow({ where: { id: attempt.providerId } });
    if (provider.adapter !== 'mock' || provider.environment !== 'TEST') throw new AppError(ErrorCode.FORBIDDEN, 'Simulation is only available for sandbox providers');
    const secret = (await this.registry.context(provider)).credentials.webhook_secret;
    if (!secret) throw new AppError(ErrorCode.INVALID_REQUEST, 'Sandbox provider has no webhook secret');
    const utr = String(Math.floor(1e11 + Math.random() * 9e11));
    const body = Buffer.from(
      JSON.stringify({
        event_id: `sbx_${randomUUID()}`,
        type: 'payout.status',
        data: {
          reference: attempt.reference,
          ...(attempt.providerReference ? { provider_reference: attempt.providerReference } : {}),
          status: outcome,
          ...(outcome === 'FAILED' ? { failure_reason: 'Beneficiary account closed (sandbox)' } : outcome === 'REVERSED' ? { utr: p.utr ?? utr, failure_reason: 'Credit returned by beneficiary bank (sandbox)' } : { utr }),
        },
      }),
    );
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    return this.inbound.receive(provider.code, body, { 'x-mock-signature': signature });
  }
}
