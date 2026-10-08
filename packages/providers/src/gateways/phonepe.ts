import { ProviderError } from '../interfaces/errors';
import type { CreatePaymentRequest, CreatePaymentResult, HealthCheckResult, PayinProvider, PaymentProviderStatus, PaymentStatusResult, ProviderContext, RefundRequest, RefundResult, WebhookVerification } from '../interfaces/types';
import { baseUrl, call, headerOf, requireCredentials, safeEqual, sha256, timedHealth } from './common';

/**
 * PhonePe Payment Gateway — Standard Checkout v2. OAuth client-credentials token
 * ("O-Bearer"), then Create Payment → redirectUrl, Order Status, Refund.
 * Webhook: Authorization = hex SHA-256 of "username:password" set in the PhonePe dashboard.
 * Docs: https://developer.phonepe.com/v1/reference/pg-standard-checkout-v2
 */
const STATE: Record<string, PaymentProviderStatus> = { completed: 'SUCCESS', failed: 'FAILED', pending: 'PENDING' };

interface PhonePeDetail {
  transactionId?: string;
  state?: string;
  amount?: number;
  errorCode?: string;
  detailedErrorCode?: string;
  rail?: { utr?: string; upiTransactionId?: string; vpa?: string };
}

/** Tokens per client (adapters are built per call; tokens live about an hour). */
const tokens = new Map<string, { token: string; expiresAt: number }>();

export class PhonePeAdapter implements PayinProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private pgHost() {
    return baseUrl(this.ctx, 'https://api-preprod.phonepe.com/apis/pg-sandbox', 'https://api.phonepe.com/apis/pg');
  }

  private async token(fresh = false): Promise<string> {
    const c = requireCredentials(this.ctx, ['client_id', 'client_secret', 'client_version']);
    const cacheKey = `${this.ctx.environment}:${c.client_id}`;
    const cached = tokens.get(cacheKey);
    if (!fresh && cached && cached.expiresAt - 120_000 > Date.now()) return cached.token;
    const { body } = await call<{ access_token: string; expires_at?: number }>(this.ctx, {
      baseUrl: baseUrl(this.ctx, 'https://api-preprod.phonepe.com/apis/pg-sandbox', 'https://api.phonepe.com/apis/identity-manager', 'auth_url'),
      method: 'POST',
      path: '/v1/oauth/token',
      form: { client_id: c.client_id, client_version: c.client_version, client_secret: c.client_secret, grant_type: 'client_credentials' },
    });
    if (!body.access_token) throw new ProviderError('CONFIGURATION', 'NO_TOKEN', 'PhonePe did not issue an access token', this.ctx.providerCode);
    tokens.set(cacheKey, { token: body.access_token, expiresAt: body.expires_at ? body.expires_at * 1000 : Date.now() + 30 * 60_000 });
    return body.access_token;
  }

  private async api<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    return call<T>(this.ctx, { baseUrl: this.pgHost(), method, path, body, headers: { Authorization: `O-Bearer ${await this.token()}` } });
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    if (!req.returnUrl) throw new ProviderError('CONFIGURATION', 'RETURN_URL_REQUIRED', 'PhonePe needs a redirect URL', this.ctx.providerCode);
    const expireAfter = Math.min(3600, Math.max(300, Math.floor((req.expiresAt.getTime() - Date.now()) / 1000)));
    const { body } = await this.api<{ orderId: string; state: string; redirectUrl: string }>('POST', '/checkout/v2/pay', {
      merchantOrderId: req.reference,
      amount: Number(req.amountMinor),
      expireAfter,
      metaInfo: { udf1: req.reference },
      paymentFlow: { type: 'PG_CHECKOUT', message: (req.description ?? 'Payment').slice(0, 100), merchantUrls: { redirectUrl: req.returnUrl } },
    });
    return { providerOrderId: req.reference, status: STATE[body.state?.toLowerCase()] ?? 'PENDING', paymentLink: body.redirectUrl, action: { type: 'REDIRECT', url: body.redirectUrl } };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    const { body } = await this.api<{ orderId: string; state: string; amount?: number; paymentDetails?: PhonePeDetail[] }>('GET', `/checkout/v2/order/${encodeURIComponent(providerOrderId)}/status?details=false`);
    const status = STATE[body.state?.toLowerCase()] ?? 'PENDING';
    const d = (body.paymentDetails ?? []).find((x) => x.state === 'COMPLETED') ?? body.paymentDetails?.[body.paymentDetails.length - 1];
    return {
      providerOrderId,
      status,
      amountMinor: body.amount !== undefined ? BigInt(body.amount) : undefined,
      providerTransactionId: d?.transactionId,
      utr: d?.rail?.utr,
      payerVpa: d?.rail?.vpa,
      failureReason: status === 'FAILED' ? (d?.detailedErrorCode ?? d?.errorCode) : undefined,
    };
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    const { body } = await this.api<{ refundId: string; state: string }>('POST', '/payments/v2/refund', { merchantRefundId: req.reference, originalMerchantOrderId: req.providerOrderId, amount: Number(req.amountMinor) });
    const s = body.state?.toUpperCase();
    return { providerRefundId: body.refundId, status: s === 'COMPLETED' ? 'SUCCESS' : s === 'FAILED' ? 'FAILED' : 'PENDING' };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const user = this.ctx.credentials.webhook_username;
    const pass = this.ctx.credentials.webhook_password;
    const expected = user && pass ? sha256(`${user}:${pass}`) : undefined;
    const given = headerOf(headers, 'authorization')?.replace(/^SHA256\s+/i, '').toLowerCase();
    if (!safeEqual(expected, given)) return { valid: false, reason: 'authorization mismatch' };
    const body = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      payload: { merchantOrderId?: string; orderId?: string; state?: string; amount?: number; paymentDetails?: PhonePeDetail[]; merchantRefundId?: string; refundId?: string; errorCode?: string };
    };
    const p = body.payload;
    if (body.event.includes('refund')) {
      return { valid: true, event: { externalEventId: `${body.event}:${p.refundId ?? p.merchantRefundId}`, type: 'refund.status', reference: p.merchantRefundId, providerReference: p.refundId, status: p.state === 'COMPLETED' ? 'SUCCESS' : p.state === 'FAILED' ? 'FAILED' : 'PENDING', failureReason: p.errorCode } };
    }
    if (!p.merchantOrderId) return { valid: false, reason: `unsupported event ${body.event}` };
    const d = (p.paymentDetails ?? []).find((x) => x.state === 'COMPLETED') ?? p.paymentDetails?.[0];
    return {
      valid: true,
      event: {
        externalEventId: `${body.event}:${p.orderId ?? p.merchantOrderId}`,
        type: 'payment.status',
        reference: p.merchantOrderId,
        providerOrderId: p.merchantOrderId,
        status: STATE[(p.state ?? '').toLowerCase()] ?? 'PENDING',
        amountMinor: p.amount !== undefined ? BigInt(p.amount) : undefined,
        utr: d?.rail?.utr,
        payerVpa: d?.rail?.vpa,
        failureReason: d?.detailedErrorCode ?? d?.errorCode,
      },
    };
  }

  healthCheck(): Promise<HealthCheckResult> {
    // Getting a token proves the client id, secret and version are right.
    return timedHealth(() => this.token(true));
  }
}
