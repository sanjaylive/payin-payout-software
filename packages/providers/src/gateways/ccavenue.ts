import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { ProviderError } from '../interfaces/errors';
import type { CreatePaymentRequest, CreatePaymentResult, HealthCheckResult, PayinProvider, PaymentProviderStatus, PaymentStatusResult, ProviderContext, RefundRequest, RefundResult, WebhookVerification } from '../interfaces/types';
import { baseUrl, call, compactRef, formBody, requireCredentials, rupees, timedHealth, toMinor } from './common';

/**
 * CCAvenue — non-seamless hosted checkout (form POST of an AES-encrypted request) and the
 * Order Status / Refund APIs (DoWebTrans). API calls need the server IP whitelisted at CCAvenue.
 *
 * Security: CCAvenue responses are AES-128-CBC without a MAC and pass through the customer's
 * browser, so their content can be tampered with. A callback is therefore only a nudge: the
 * outcome always comes from the server-to-server Order Status API.
 * Docs: https://www.ccavenue.com/ (Integration kit + API documentation in the merchant dashboard)
 */
const IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const key = (workingKey: string) => createHash('md5').update(workingKey).digest();

export function ccavEncrypt(plain: string, workingKey: string): string {
  const c = createCipheriv('aes-128-cbc', key(workingKey), IV);
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('hex');
}

export function ccavDecrypt(hex: string, workingKey: string): string {
  const d = createDecipheriv('aes-128-cbc', key(workingKey), IV);
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8');
}

const ORDER_STATUS: Record<string, PaymentProviderStatus> = {
  successful: 'SUCCESS',
  success: 'SUCCESS',
  shipped: 'SUCCESS',
  refunded: 'SUCCESS',
  'partially refunded': 'SUCCESS',
  aborted: 'FAILED',
  unsuccessful: 'FAILED',
  failure: 'FAILED',
  invalid: 'FAILED',
  timeout: 'FAILED',
  cancelled: 'FAILED',
  'auto-cancelled': 'FAILED',
  'auto-reversed': 'FAILED',
  'system refund': 'FAILED',
  awaited: 'PENDING',
  initiated: 'PENDING',
};

export class CcavenueAdapter implements PayinProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private get creds() {
    return requireCredentials(this.ctx, ['merchant_id', 'access_code', 'working_key']);
  }

  private async api<T>(command: string, payload: Record<string, unknown>): Promise<T> {
    const { access_code, working_key } = this.creds;
    const { body } = await call<string>(this.ctx, {
      baseUrl: baseUrl(this.ctx, 'https://apitest.ccavenue.com', 'https://api.ccavenue.com', 'api_url'),
      method: 'POST',
      path: '/apis/servlet/DoWebTrans',
      form: { enc_request: ccavEncrypt(JSON.stringify(payload), working_key), access_code, command, request_type: 'JSON', response_type: 'JSON', version: '1.2' },
      responseType: 'text',
    });
    const res = Object.fromEntries(new URLSearchParams(body.trim()));
    if (res.status !== '0') {
      const reason = res.enc_response ?? res.enc_error_code ?? body.slice(0, 120);
      throw new ProviderError(/ip|access code|authenticat/i.test(reason) ? 'CONFIGURATION' : 'REJECTED', 'CCAVENUE_API_ERROR', `CCAvenue ${command} failed: ${reason}`, this.ctx.providerCode);
    }
    return JSON.parse(ccavDecrypt(res.enc_response ?? '', working_key)) as T;
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const { merchant_id, access_code, working_key } = this.creds;
    if (!req.returnUrl) throw new ProviderError('CONFIGURATION', 'RETURN_URL_REQUIRED', 'CCAvenue needs a return URL', this.ctx.providerCode);
    const orderId = compactRef(req.reference, 30);
    const c = req.customer ?? {};
    const params = new URLSearchParams({
      merchant_id,
      order_id: orderId,
      currency: 'INR',
      amount: rupees(req.amountMinor),
      redirect_url: req.returnUrl,
      cancel_url: req.returnUrl,
      language: 'EN',
      ...(c.name ? { billing_name: c.name } : {}),
      ...(c.mobile ? { billing_tel: c.mobile } : {}),
      ...(c.email ? { billing_email: c.email } : {}),
      merchant_param1: req.reference,
    });
    const host = baseUrl(this.ctx, 'https://test.ccavenue.com', 'https://secure.ccavenue.com');
    return {
      providerOrderId: orderId,
      status: 'PENDING',
      action: { type: 'FORM_POST', url: `${host}/transaction/transaction.do?command=initiateTransaction`, fields: { encRequest: ccavEncrypt(params.toString(), working_key), access_code } },
    };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    const r = await this.api<{ order_status?: string; status?: number; error_desc?: string; reference_no?: string; order_amt?: number | string; order_bank_ref_no?: string; order_status_date_time?: string }>('orderStatusTracker', { order_no: providerOrderId });
    if (r.status === 1 && !r.order_status) return { providerOrderId, status: 'PENDING', failureReason: r.error_desc };
    const s = (r.order_status ?? '').toLowerCase();
    return {
      providerOrderId,
      status: ORDER_STATUS[s] ?? 'PENDING',
      amountMinor: toMinor(r.order_amt),
      providerTransactionId: r.reference_no,
      utr: r.order_bank_ref_no,
      failureReason: ORDER_STATUS[s] === 'FAILED' ? r.order_status : undefined,
    };
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    const tracking = req.providerTransactionId ?? (await this.getPaymentStatus(req.providerOrderId)).providerTransactionId;
    if (!tracking) return { providerRefundId: '', status: 'FAILED', failureReason: 'No CCAvenue tracking id for this payment' };
    const r = await this.api<{ Refund_Order_Result?: { refund_status: number; reason?: string } }>('refundOrder', { reference_no: tracking, refund_amount: rupees(req.amountMinor), refund_ref_no: compactRef(req.reference, 30) });
    const ok = r.Refund_Order_Result?.refund_status === 0;
    return ok ? { providerRefundId: compactRef(req.reference, 30), status: 'SUCCESS' } : { providerRefundId: '', status: 'FAILED', failureReason: r.Refund_Order_Result?.reason ?? 'Refund refused' };
  }

  /**
   * A notification only tells us which order to look at; its status is not trusted (see above).
   * It must still decrypt with our working key and name an order we created.
   */
  verifyWebhook(rawBody: Buffer): WebhookVerification {
    const { working_key } = this.creds;
    const enc = formBody(rawBody).encResp;
    if (!enc || !/^[0-9a-f]+$/i.test(enc)) return { valid: false, reason: 'missing encResp' };
    let fields: Record<string, string>;
    try {
      fields = Object.fromEntries(new URLSearchParams(ccavDecrypt(enc, working_key)));
    } catch {
      return { valid: false, reason: 'cannot decrypt' };
    }
    if (!fields.order_id) return { valid: false, reason: 'no order_id' };
    return { valid: true, event: { externalEventId: `${fields.order_id}:${fields.tracking_id ?? ''}:${fields.order_status ?? ''}`, type: 'payment.status', providerOrderId: fields.order_id, reference: fields.merchant_param1, status: 'PENDING', confirmByStatusApi: true } };
  }

  healthCheck(): Promise<HealthCheckResult> {
    // Looking up an order that doesn't exist still needs a valid access code, key and whitelisted IP.
    return timedHealth(() => this.api('orderStatusTracker', { order_no: 'HEALTHCHECK0' }));
  }
}
