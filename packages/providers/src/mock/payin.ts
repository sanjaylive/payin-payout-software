import { ProviderError } from '../interfaces/errors';
import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  PayinProvider,
  PaymentStatusResult,
  ProviderContext,
  RefundRequest,
  RefundResult,
} from '../interfaces/types';
import { cfg, digits, mockHealthCheck, paise, settings, simulateLatency, ulidTime, verifyMockWebhook } from './shared';

/**
 * Sandbox UPI collection provider. Stateless and deterministic so it behaves the same on every API
 * node; outcomes are scripted by the amount's paise:
 *   .13 → FAILED   .50 → stays PENDING   .77 → provider 5xx (AMBIGUOUS)   otherwise SUCCESS after a delay
 */
export class MockPayinProvider implements PayinProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private orderId(reference: string, amountMinor: bigint) {
    return `mockord_${amountMinor}_${reference}`;
  }

  private decode(providerOrderId: string): { amountMinor: bigint; reference: string } {
    const match = /^mockord_(\d+)_(.+)$/.exec(providerOrderId);
    if (!match) throw new ProviderError('REJECTED', 'ORDER_NOT_FOUND', 'Unknown order', this.ctx.providerCode, 404);
    return { amountMinor: BigInt(match[1]!), reference: match[2]! };
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    await simulateLatency(this.ctx);
    if (req.amountMinor <= 0n) throw new ProviderError('REJECTED', 'INVALID_AMOUNT', 'Amount must be positive', this.ctx.providerCode);
    const providerOrderId = this.orderId(req.reference, req.amountMinor);
    const vpa = cfg(this.ctx, 'collect_vpa', 'pay2all.mock@upi');
    const major = `${req.amountMinor / 100n}.${String(req.amountMinor % 100n).padStart(2, '0')}`;
    const upi = `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent('Pay2All Merchant')}&am=${major}&cu=INR&tr=${encodeURIComponent(req.reference)}`;
    return {
      providerOrderId,
      status: 'PENDING',
      upiIntent: upi,
      qrPayload: upi,
      ...(req.method === 'PAYMENT_LINK' ? { paymentLink: `${cfg(this.ctx, 'link_base', 'https://pay.sandbox.pay2all.local')}/l/${providerOrderId}` } : {}),
      expiresAt: req.expiresAt,
    };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    await simulateLatency(this.ctx);
    const { amountMinor, reference } = this.decode(providerOrderId);
    const p = paise(amountMinor);
    if (p === 77) throw new ProviderError('AMBIGUOUS', 'PROVIDER_5XX', 'Simulated provider error', this.ctx.providerCode, 502);
    const age = Date.now() - ulidTime(reference);
    if (p === 50 || age < settings(this.ctx).autoSuccessAfterMs) return { providerOrderId, status: 'PENDING', amountMinor };
    if (p === 13) return { providerOrderId, status: 'FAILED', amountMinor, failureReason: 'Payer declined the collect request' };
    return {
      providerOrderId,
      status: 'SUCCESS',
      amountMinor,
      providerTransactionId: `MOCKTXN${digits(reference, 12)}`,
      utr: digits(`utr:${reference}`, 12),
      rrn: digits(`rrn:${reference}`, 12),
      payerVpa: 'customer@mockbank',
      completedAt: new Date(ulidTime(reference) + settings(this.ctx).autoSuccessAfterMs),
    };
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    await simulateLatency(this.ctx);
    if (paise(req.amountMinor) === 13) return { providerRefundId: `mockrf_${req.reference}`, status: 'FAILED', failureReason: 'Simulated refund failure' };
    return { providerRefundId: `mockrf_${req.reference}`, status: 'SUCCESS' };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>) {
    return verifyMockWebhook(this.ctx, rawBody, headers);
  }

  healthCheck() {
    return mockHealthCheck(this.ctx);
  }
}
