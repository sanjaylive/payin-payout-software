import { ProviderError } from '../interfaces/errors';
import type { CreatePaymentRequest, CreatePaymentResult, HealthCheckResult, PayinProvider, PaymentProviderStatus, PaymentStatusResult, ProviderContext, RefundRequest, RefundResult, WebhookVerification } from '../interfaces/types';
import { baseUrl, call, compactRef, headerOf, requireCredentials, restoreRef, rupees, safeEqual, timedHealth, toMinor } from './common';

/**
 * HDFC Bank SmartGateway (Juspay platform) — Session API (hosted payment page), Order Status and
 * Refund APIs. Auth: HTTP Basic with the API key as username and an empty password, plus
 * x-merchantid. Hosts: smartgatewayuat.hdfcbank.com / smartgateway.hdfcbank.com.
 * Webhook: HTTP Basic credentials you set in the SmartGateway dashboard (webhook_username/password).
 * Docs: https://smartgateway.hdfcbank.com/docs
 */
const ORDER_STATUS: Record<string, PaymentProviderStatus> = {
  charged: 'SUCCESS',
  auto_refunded: 'FAILED',
  authentication_failed: 'FAILED',
  authorization_failed: 'FAILED',
  juspay_declined: 'FAILED',
  not_found: 'FAILED',
  new: 'PENDING',
  pending_vbv: 'PENDING',
  authorizing: 'PENDING',
  started: 'PENDING',
  partial_charged: 'PENDING',
};

interface JuspayOrder {
  order_id: string;
  status: string;
  amount?: number | string;
  txn_id?: string;
  bank_error_message?: string;
  payment_gateway_response?: { epg_txn_id?: string; rrn?: string; auth_id_code?: string };
  upi?: { payer_vpa?: string };
}

export class HdfcSmartGatewayAdapter implements PayinProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private api<T>(method: 'GET' | 'POST', path: string, opts: { body?: unknown; form?: Record<string, string>; customerId?: string } = {}) {
    const c = requireCredentials(this.ctx, ['api_key', 'merchant_id']);
    return call<T>(this.ctx, {
      baseUrl: baseUrl(this.ctx, 'https://smartgatewayuat.hdfcbank.com', 'https://smartgateway.hdfcbank.com'),
      method,
      path,
      body: opts.body,
      form: opts.form,
      headers: { Authorization: `Basic ${Buffer.from(`${c.api_key}:`).toString('base64')}`, 'x-merchantid': c.merchant_id, ...(opts.customerId ? { 'x-customerid': opts.customerId } : {}) },
    });
  }

  /** SmartGateway order ids are limited to 21 characters. */
  static orderId(reference: string) {
    return compactRef(reference, 21);
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const clientId = this.ctx.credentials.payment_page_client_id;
    if (!clientId) throw new ProviderError('CONFIGURATION', 'MISSING_CREDENTIALS', 'HDFC SmartGateway needs the payment page client id', this.ctx.providerCode);
    const orderId = HdfcSmartGatewayAdapter.orderId(req.reference);
    const customerId = `cust${(req.customer?.mobile ?? orderId).replace(/\D/g, '').slice(-12) || orderId}`;
    const { body } = await this.api<{ id: string; order_id: string; status: string; payment_links?: { web?: string } }>('POST', '/session', {
      customerId,
      body: {
        order_id: orderId,
        amount: rupees(req.amountMinor),
        currency: 'INR',
        customer_id: customerId,
        customer_email: req.customer?.email,
        customer_phone: req.customer?.mobile,
        first_name: req.customer?.name,
        payment_page_client_id: clientId,
        action: 'paymentPage',
        return_url: req.returnUrl,
        description: req.description?.slice(0, 255),
        udf1: req.reference,
      },
    });
    const url = body.payment_links?.web;
    if (!url) throw new ProviderError('AMBIGUOUS', 'NO_PAYMENT_LINK', 'SmartGateway did not return a payment page link', this.ctx.providerCode);
    return { providerOrderId: body.order_id ?? orderId, status: 'PENDING', paymentLink: url, action: { type: 'REDIRECT', url } };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    const { body } = await this.api<JuspayOrder>('GET', `/orders/${encodeURIComponent(providerOrderId)}`);
    const status = ORDER_STATUS[(body.status ?? '').toLowerCase()] ?? 'PENDING';
    return {
      providerOrderId: body.order_id ?? providerOrderId,
      status,
      amountMinor: toMinor(body.amount),
      providerTransactionId: body.txn_id,
      rrn: body.payment_gateway_response?.rrn,
      utr: body.payment_gateway_response?.epg_txn_id,
      payerVpa: body.upi?.payer_vpa,
      failureReason: status === 'FAILED' ? (body.bank_error_message ?? body.status) : undefined,
    };
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    const { body } = await this.api<{ refunds?: { unique_request_id: string; status: string; error_message?: string }[] }>('POST', `/orders/${encodeURIComponent(req.providerOrderId)}/refunds`, {
      form: { unique_request_id: compactRef(req.reference, 30), amount: rupees(req.amountMinor) },
    });
    const r = (body.refunds ?? []).find((x) => x.unique_request_id === compactRef(req.reference, 30));
    const s = (r?.status ?? 'PENDING').toUpperCase();
    return { providerRefundId: r?.unique_request_id ?? compactRef(req.reference, 30), status: s === 'SUCCESS' ? 'SUCCESS' : s === 'FAILURE' ? 'FAILED' : 'PENDING', failureReason: r?.error_message };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const user = this.ctx.credentials.webhook_username;
    const pass = this.ctx.credentials.webhook_password;
    const expected = user && pass ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : undefined;
    if (!safeEqual(expected, headerOf(headers, 'authorization'))) return { valid: false, reason: 'basic auth mismatch' };
    const body = JSON.parse(rawBody.toString('utf8')) as { id?: string; event_name: string; date_created?: string; content: { order?: JuspayOrder & { udf1?: string; refunds?: { unique_request_id: string; status: string }[] } } };
    const o = body.content.order;
    if (!o) return { valid: false, reason: `unsupported event ${body.event_name}` };
    const id = body.id ?? `${body.event_name}:${o.order_id}:${body.date_created ?? ''}`;
    if (body.event_name.startsWith('REFUND') && o.refunds?.length) {
      const r = o.refunds[o.refunds.length - 1]!;
      return { valid: true, event: { externalEventId: id, type: 'refund.status', reference: restoreRef(r.unique_request_id), providerReference: r.unique_request_id, status: r.status === 'SUCCESS' ? 'SUCCESS' : r.status === 'FAILURE' ? 'FAILED' : 'PENDING' } };
    }
    return {
      valid: true,
      event: {
        externalEventId: id,
        type: 'payment.status',
        reference: o.udf1,
        providerOrderId: o.order_id,
        status: ORDER_STATUS[(o.status ?? '').toLowerCase()] ?? 'PENDING',
        amountMinor: toMinor(o.amount),
        rrn: o.payment_gateway_response?.rrn,
        payerVpa: o.upi?.payer_vpa,
        failureReason: o.bank_error_message,
      },
    };
  }

  healthCheck(): Promise<HealthCheckResult> {
    // An unknown order answers 404 with valid credentials, 401 without.
    return timedHealth(() =>
      this.api('GET', '/orders/HEALTHCHECK').catch((err: unknown) => {
        if (err instanceof ProviderError && (err.httpStatus === 404 || err.httpStatus === 400)) return;
        throw err;
      }),
    );
  }
}
