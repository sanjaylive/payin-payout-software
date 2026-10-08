import { verifyHmac } from '../http/client';
import { ProviderError } from '../interfaces/errors';
import type { CreatePaymentRequest, CreatePaymentResult, CreateStaticQrRequest, HealthCheckResult, PayinProvider, PaymentProviderStatus, PaymentStatusResult, ProviderContext, RefundRequest, RefundResult, StaticQrCredit, StaticQrProvider, StaticQrResult, WebhookVerification } from '../interfaces/types';
import { baseUrl, call, headerOf, mapStatus, requireCredentials, timedHealth } from './common';

/**
 * Razorpay — Payment Links API (hosted page, every method Razorpay has enabled for the account).
 * Auth: HTTP Basic key_id:key_secret. Test vs live is decided by the key (rzp_test_ / rzp_live_).
 * Webhook: X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook secret).
 * Docs: https://razorpay.com/docs/api/payments/payment-links/
 *
 * Static QR: QR Codes API (upi_qr, multiple_use, any amount); credits arrive as `qr_code.credited`
 * webhooks and are re-listed from GET /v1/payments/qr_codes/:id/payments for reconciliation.
 * Docs: https://razorpay.com/docs/api/qr-codes/
 */
const LINK_STATUS: Record<string, PaymentProviderStatus> = { created: 'PENDING', partially_paid: 'PENDING', paid: 'SUCCESS', cancelled: 'FAILED', expired: 'EXPIRED' };

interface RzpPayment {
  id: string;
  amount: number;
  status: string;
  method?: string;
  vpa?: string;
  error_description?: string;
  acquirer_data?: { rrn?: string; upi_transaction_id?: string; bank_transaction_id?: string };
  created_at?: number;
}

export class RazorpayAdapter implements PayinProvider, StaticQrProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private api<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    const c = requireCredentials(this.ctx, ['key_id', 'key_secret']);
    return call<T>(this.ctx, {
      baseUrl: baseUrl(this.ctx, 'https://api.razorpay.com', 'https://api.razorpay.com'),
      method,
      path,
      body,
      headers: { Authorization: `Basic ${Buffer.from(`${c.key_id}:${c.key_secret}`).toString('base64')}` },
    });
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    // Razorpay requires expire_by at least 15 minutes ahead.
    const expireBy = Math.max(Math.floor(req.expiresAt.getTime() / 1000), Math.floor(Date.now() / 1000) + 16 * 60);
    const { body } = await this.api<{ id: string; short_url: string; status: string }>('POST', '/v1/payment_links', {
      amount: Number(req.amountMinor),
      currency: 'INR',
      reference_id: req.reference,
      description: (req.description ?? `Payment ${req.reference}`).slice(0, 2048),
      customer: { name: req.customer?.name, email: req.customer?.email, contact: req.customer?.mobile },
      notify: { sms: false, email: false },
      reminder_enable: false,
      expire_by: expireBy,
      ...(req.returnUrl ? { callback_url: req.returnUrl, callback_method: 'get' } : {}),
      notes: { reference: req.reference },
    });
    return { providerOrderId: body.id, status: mapStatus(this.ctx, LINK_STATUS, body.status), paymentLink: body.short_url, action: { type: 'REDIRECT', url: body.short_url } };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    const { body } = await this.api<{ id: string; status: string; amount_paid?: number; payments?: { payment_id: string; amount: number; status: string }[] | null }>('GET', `/v1/payment_links/${encodeURIComponent(providerOrderId)}`);
    const captured = (body.payments ?? []).find((p) => p.status === 'captured');
    let detail: RzpPayment | undefined;
    if (captured) detail = (await this.api<RzpPayment>('GET', `/v1/payments/${encodeURIComponent(captured.payment_id)}`)).body;
    return {
      providerOrderId: body.id,
      status: mapStatus(this.ctx, LINK_STATUS, body.status),
      amountMinor: body.amount_paid !== undefined ? BigInt(body.amount_paid) : undefined,
      providerTransactionId: captured?.payment_id,
      rrn: detail?.acquirer_data?.rrn,
      utr: detail?.acquirer_data?.upi_transaction_id ?? detail?.acquirer_data?.bank_transaction_id,
      payerVpa: detail?.vpa,
    };
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    const paymentId = req.providerTransactionId ?? (await this.getPaymentStatus(req.providerOrderId)).providerTransactionId;
    if (!paymentId) return { providerRefundId: '', status: 'FAILED', failureReason: 'No captured Razorpay payment for this link' };
    const { body } = await this.api<{ id: string; status: string }>('POST', `/v1/payments/${encodeURIComponent(paymentId)}/refund`, { amount: Number(req.amountMinor), receipt: req.reference, notes: { reason: req.reason ?? '' } });
    return { providerRefundId: body.id, status: body.status === 'processed' ? 'SUCCESS' : body.status === 'failed' ? 'FAILED' : 'PENDING' };
  }

  // ---- Static QR ---------------------------------------------------------------------------------

  async createStaticQr(req: CreateStaticQrRequest): Promise<StaticQrResult> {
    const { body } = await this.api<{ id: string; image_url?: string; image_content?: string }>('POST', '/v1/payments/qr_codes', {
      type: 'upi_qr',
      name: req.name.slice(0, 50),
      usage: 'multiple_use',
      fixed_amount: false,
      description: (req.description ?? req.name).slice(0, 255),
      notes: { reference: req.reference },
    });
    const upiPayload = body.image_content?.startsWith('upi://') ? body.image_content : undefined;
    if (!upiPayload && !body.image_url?.startsWith('https://')) throw new ProviderError('AMBIGUOUS', 'NO_QR', 'Razorpay returned a QR code without an image or UPI string', this.ctx.providerCode);
    return { providerQrId: body.id, upiPayload, imageUrl: body.image_url };
  }

  async closeStaticQr(providerQrId: string): Promise<void> {
    await this.api('POST', `/v1/payments/qr_codes/${encodeURIComponent(providerQrId)}/close`);
  }

  async listStaticQrCredits(providerQrId: string, since: Date): Promise<StaticQrCredit[]> {
    const from = Math.floor(since.getTime() / 1000);
    const { body } = await this.api<{ items: RzpPayment[] }>('GET', `/v1/payments/qr_codes/${encodeURIComponent(providerQrId)}/payments?from=${from}&count=100`);
    return body.items.filter((p) => p.status === 'captured').map((p) => this.credit(p));
  }

  private credit(p: RzpPayment): StaticQrCredit {
    return {
      providerPaymentId: p.id,
      amountMinor: BigInt(p.amount),
      rrn: p.acquirer_data?.rrn,
      utr: p.acquirer_data?.upi_transaction_id ?? p.acquirer_data?.rrn,
      payerVpa: p.vpa,
      paidAt: p.created_at ? new Date(p.created_at * 1000) : undefined,
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const secret = this.ctx.credentials.webhook_secret;
    if (!secret || !verifyHmac(secret, rawBody, headerOf(headers, 'x-razorpay-signature'))) return { valid: false, reason: 'signature mismatch' };
    const body = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      created_at?: number;
      payload: { payment_link?: { entity: { id: string; reference_id?: string; status: string } }; payment?: { entity: RzpPayment }; refund?: { entity: { id: string; status: string; payment_id: string; receipt?: string } }; qr_code?: { entity: { id: string } } };
    };
    const eventId = headerOf(headers, 'x-razorpay-event-id') ?? `${body.event}:${body.payload.payment_link?.entity.id ?? body.payload.payment?.entity.id ?? body.payload.refund?.entity.id}:${body.created_at ?? ''}`;
    if (body.event.startsWith('refund.') && body.payload.refund) {
      const r = body.payload.refund.entity;
      return { valid: true, event: { externalEventId: eventId, type: 'refund.status', reference: r.receipt, providerReference: r.id, status: r.status === 'processed' ? 'SUCCESS' : r.status === 'failed' ? 'FAILED' : 'PENDING' } };
    }
    if (body.event === 'qr_code.credited' && body.payload.qr_code && body.payload.payment) {
      const p = this.credit(body.payload.payment.entity);
      // Only captured money is a credit; anything else is stored and ignored.
      const captured = body.payload.payment.entity.status === 'captured';
      return {
        valid: true,
        event: { externalEventId: eventId, type: 'static_qr.credit', providerQrId: body.payload.qr_code.entity.id, providerReference: p.providerPaymentId, status: captured ? 'SUCCESS' : 'PENDING', amountMinor: p.amountMinor, utr: p.utr, rrn: p.rrn, payerVpa: p.payerVpa, paidAt: p.paidAt?.toISOString() },
      };
    }
    const link = body.payload.payment_link?.entity;
    const pay = body.payload.payment?.entity;
    if (!link) return { valid: false, reason: `unsupported event ${body.event}` };
    const status = body.event === 'payment_link.paid' ? 'SUCCESS' : body.event === 'payment_link.expired' ? 'EXPIRED' : body.event === 'payment_link.cancelled' ? 'FAILED' : (LINK_STATUS[link.status] ?? 'PENDING');
    return {
      valid: true,
      event: {
        externalEventId: eventId,
        type: 'payment.status',
        reference: link.reference_id,
        providerOrderId: link.id,
        status,
        amountMinor: pay ? BigInt(pay.amount) : undefined,
        rrn: pay?.acquirer_data?.rrn,
        utr: pay?.acquirer_data?.upi_transaction_id ?? pay?.acquirer_data?.bank_transaction_id,
        payerVpa: pay?.vpa,
      },
    };
  }

  healthCheck(): Promise<HealthCheckResult> {
    // Any authenticated read proves the keys work.
    return timedHealth(() => this.api('GET', '/v1/payment_links?count=1'));
  }
}
