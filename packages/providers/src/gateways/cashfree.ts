import { createHmac } from 'node:crypto';
import { ProviderError } from '../interfaces/errors';
import type { CreatePaymentRequest, CreatePaymentResult, HealthCheckResult, PayinProvider, PaymentProviderStatus, PaymentStatusResult, ProviderContext, RefundRequest, RefundResult, WebhookVerification } from '../interfaces/types';
import { baseUrl, call, headerOf, mapStatus, requireCredentials, rupees, safeEqual, timedHealth, toMinor } from './common';

/**
 * Cashfree Payments — Payment Links API (PG v2023-08-01).
 * Auth: x-client-id / x-client-secret headers. Hosts: sandbox.cashfree.com / api.cashfree.com.
 * Webhook: x-webhook-signature = base64 HMAC-SHA256(x-webhook-timestamp + raw body, client secret).
 * Docs: https://docs.cashfree.com/reference/pg-new-apis-endpoint
 */
const API_VERSION = '2023-08-01';
const LINK_STATUS: Record<string, PaymentProviderStatus> = { active: 'PENDING', partially_paid: 'PENDING', paid: 'SUCCESS', expired: 'EXPIRED', cancelled: 'FAILED' };

interface CfOrder {
  order_id: string;
  order_status: string;
  order_amount?: number;
}
interface CfPayment {
  cf_payment_id: string | number;
  payment_status: string;
  payment_amount?: number;
  bank_reference?: string;
  payment_method?: { upi?: { upi_id?: string } };
  payment_message?: string;
}

export class CashfreeAdapter implements PayinProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private api<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
    const c = requireCredentials(this.ctx, ['client_id', 'client_secret']);
    return call<T>(this.ctx, {
      baseUrl: baseUrl(this.ctx, 'https://sandbox.cashfree.com', 'https://api.cashfree.com'),
      method,
      path,
      body,
      headers: { 'x-client-id': c.client_id, 'x-client-secret': c.client_secret, 'x-api-version': API_VERSION },
    });
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    if (!req.customer?.mobile) throw new ProviderError('REJECTED', 'CUSTOMER_PHONE_REQUIRED', 'Cashfree needs the customer mobile number', this.ctx.providerCode);
    const { body } = await this.api<{ link_id: string; link_url: string; link_status: string }>('POST', '/pg/links', {
      link_id: req.reference,
      link_amount: Number(rupees(req.amountMinor)),
      link_currency: 'INR',
      link_purpose: (req.description ?? `Payment ${req.reference}`).slice(0, 500),
      customer_details: { customer_phone: req.customer.mobile, customer_name: req.customer?.name, customer_email: req.customer?.email },
      link_partial_payments: false,
      link_expiry_time: req.expiresAt.toISOString(),
      link_notify: { send_sms: false, send_email: false },
      link_auto_reminders: false,
      link_meta: { ...(req.returnUrl ? { return_url: req.returnUrl } : {}), ...(req.notifyUrl ? { notify_url: req.notifyUrl } : {}) },
    });
    return { providerOrderId: body.link_id, status: mapStatus(this.ctx, LINK_STATUS, body.link_status), paymentLink: body.link_url, action: { type: 'REDIRECT', url: body.link_url } };
  }

  /** The successful order behind a link, and its successful payment. */
  private async paid(linkId: string): Promise<{ order?: CfOrder; payment?: CfPayment }> {
    const { body: orders } = await this.api<CfOrder[]>('GET', `/pg/links/${encodeURIComponent(linkId)}/orders`);
    const order = (orders ?? []).find((o) => o.order_status === 'PAID');
    if (!order) return {};
    const { body: payments } = await this.api<CfPayment[]>('GET', `/pg/orders/${encodeURIComponent(order.order_id)}/payments`);
    return { order, payment: (payments ?? []).find((p) => p.payment_status === 'SUCCESS') };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    const { body } = await this.api<{ link_id: string; link_status: string; link_amount_paid?: number }>('GET', `/pg/links/${encodeURIComponent(providerOrderId)}`);
    const status = mapStatus(this.ctx, LINK_STATUS, body.link_status);
    const { order, payment } = status === 'SUCCESS' ? await this.paid(providerOrderId) : {};
    return {
      providerOrderId: body.link_id,
      status,
      amountMinor: toMinor(body.link_amount_paid),
      providerTransactionId: order?.order_id,
      utr: payment?.bank_reference,
      payerVpa: payment?.payment_method?.upi?.upi_id,
    };
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    const orderId = req.providerTransactionId ?? (await this.paid(req.providerOrderId)).order?.order_id;
    if (!orderId) return { providerRefundId: '', status: 'FAILED', failureReason: 'No paid Cashfree order for this link' };
    const { body } = await this.api<{ cf_refund_id: string; refund_id: string; refund_status: string }>('POST', `/pg/orders/${encodeURIComponent(orderId)}/refunds`, {
      refund_amount: Number(rupees(req.amountMinor)),
      refund_id: req.reference,
      refund_note: req.reason?.slice(0, 100),
    });
    return { providerRefundId: String(body.cf_refund_id ?? body.refund_id), status: body.refund_status === 'SUCCESS' ? 'SUCCESS' : body.refund_status === 'CANCELLED' ? 'FAILED' : 'PENDING' };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const secret = this.ctx.credentials.client_secret;
    const ts = headerOf(headers, 'x-webhook-timestamp');
    const expected = secret && ts ? createHmac('sha256', secret).update(ts + rawBody.toString('utf8')).digest('base64') : undefined;
    if (!safeEqual(expected, headerOf(headers, 'x-webhook-signature'))) return { valid: false, reason: 'signature mismatch' };
    const body = JSON.parse(rawBody.toString('utf8')) as {
      type: string;
      event_time?: string;
      data: {
        link_id?: string;
        link_status?: string;
        link_amount_paid?: number;
        order?: { order_id?: string; transaction_id?: string | number; transaction_status?: string; order_amount?: number };
        refund?: { refund_id?: string; cf_refund_id?: string | number; refund_status?: string };
      };
    };
    const id = `${body.type}:${body.data.link_id ?? body.data.refund?.refund_id ?? ''}:${body.event_time ?? ts}`;
    if (body.type.startsWith('REFUND') && body.data.refund) {
      const r = body.data.refund;
      return { valid: true, event: { externalEventId: id, type: 'refund.status', reference: r.refund_id, providerReference: String(r.cf_refund_id ?? ''), status: r.refund_status === 'SUCCESS' ? 'SUCCESS' : r.refund_status === 'CANCELLED' ? 'FAILED' : 'PENDING' } };
    }
    if (!body.data.link_id) return { valid: false, reason: `unsupported event ${body.type}` };
    const linkStatus = (body.data.link_status ?? '').toLowerCase();
    return {
      valid: true,
      event: {
        externalEventId: id,
        type: 'payment.status',
        reference: body.data.link_id,
        providerOrderId: body.data.link_id,
        status: LINK_STATUS[linkStatus] ?? (body.data.order?.transaction_status === 'SUCCESS' ? 'SUCCESS' : 'PENDING'),
        amountMinor: toMinor(body.data.link_amount_paid ?? body.data.order?.order_amount),
      },
    };
  }

  healthCheck(): Promise<HealthCheckResult> {
    // Reading an id that can't exist: 404 means the credentials were accepted (401 would throw).
    return timedHealth(() =>
      this.api('GET', '/pg/links/healthcheck-pay2all').catch((err: unknown) => {
        if (err instanceof ProviderError && (err.httpStatus === 404 || err.httpStatus === 400)) return;
        throw err;
      }),
    );
  }
}
