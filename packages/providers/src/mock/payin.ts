import { ProviderError } from '../interfaces/errors';
import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  CreateStaticQrRequest,
  PayinProvider,
  PaymentStatusResult,
  ProviderContext,
  RefundRequest,
  RefundResult,
  StaticQrCredit,
  StaticQrProvider,
  StaticQrResult,
} from '../interfaces/types';
import { cfg, digits, mockHealthCheck, paise, settings, simulateLatency, ulidTime, verifyMockWebhook } from './shared';

/**
 * Sandbox UPI collection provider. Stateless and deterministic so it behaves the same on every API
 * node; outcomes are scripted by the amount's paise:
 *   .13 → FAILED   .50 → stays PENDING   .77 → status check 5xx (AMBIGUOUS)
 *   .91 → createPayment REJECTED (safe to fail over)   .92 → createPayment times out (AMBIGUOUS)
 *   otherwise SUCCESS after a delay
 * `config.scripted_create_failures: false` disables .91/.92 (used by the fallback sandbox so failover
 * can be demonstrated end to end).
 */
export class MockPayinProvider implements PayinProvider, StaticQrProvider {
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
    const scripted = this.ctx.config.scripted_create_failures !== false;
    if (scripted && paise(req.amountMinor) === 91) throw new ProviderError('REJECTED', 'COLLECT_NOT_SUPPORTED', 'Simulated rejection at order creation', this.ctx.providerCode, 422);
    if (scripted && paise(req.amountMinor) === 92) throw new ProviderError('AMBIGUOUS', 'TIMEOUT', 'Simulated timeout creating the order', this.ctx.providerCode);
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

  /**
   * Static QR: stateless like the rest of the sandbox — credits arrive only through signed sandbox
   * callbacks (POST /v1/sandbox/static-qrs/:id/pay), so there is nothing to list when polling.
   */
  async createStaticQr(req: CreateStaticQrRequest): Promise<StaticQrResult> {
    await simulateLatency(this.ctx);
    const providerQrId = `mockqr_${req.reference}`;
    const vpa = cfg(this.ctx, 'collect_vpa', 'pay2all.mock@upi');
    return { providerQrId, upiPayload: `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(req.name.slice(0, 50))}&tr=${encodeURIComponent(providerQrId)}&cu=INR&mc=5411` };
  }

  async closeStaticQr(): Promise<void> {
    await simulateLatency(this.ctx);
  }

  listStaticQrCredits(): Promise<StaticQrCredit[]> {
    return Promise.resolve([]);
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>) {
    return verifyMockWebhook(this.ctx, rawBody, headers);
  }

  healthCheck() {
    return mockHealthCheck(this.ctx);
  }
}
