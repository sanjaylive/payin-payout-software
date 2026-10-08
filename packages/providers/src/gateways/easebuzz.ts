import { ProviderError } from '../interfaces/errors';
import type { CreatePaymentRequest, CreatePaymentResult, HealthCheckResult, PayinProvider, PaymentProviderStatus, PaymentStatusResult, ProviderContext, RefundRequest, RefundResult, WebhookVerification } from '../interfaces/types';
import { baseUrl, call, formBody, requireCredentials, rupees, safeEqual, sha512, timedHealth, toMinor } from './common';

/**
 * Easebuzz — Initiate Payment API (hosted page) + Transaction / Refund APIs.
 * Requests are form-encoded and signed with SHA-512 over pipe-joined fields ending with the salt.
 * Webhook / return: the reverse hash `salt|status|udf10…udf1|email|firstname|productinfo|amount|txnid|key`.
 * Docs: https://docs.easebuzz.in/
 */
const TXN_STATUS: Record<string, PaymentProviderStatus> = {
  success: 'SUCCESS',
  failure: 'FAILED',
  usercancelled: 'FAILED',
  dropped: 'FAILED',
  bounced: 'FAILED',
  pending: 'PENDING',
  initiated: 'PENDING',
};
const UDF = Array.from({ length: 10 }, (_, i) => `udf${i + 1}`);

interface EbTxn {
  txnid: string;
  status: string;
  amount?: string;
  easepayid?: string;
  bank_ref_num?: string;
  upi_va?: string;
  error_Message?: string;
  email?: string;
  firstname?: string;
  productinfo?: string;
  key?: string;
  hash?: string;
  [udf: string]: string | undefined;
}

export class EasebuzzAdapter implements PayinProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private get creds() {
    return requireCredentials(this.ctx, ['key', 'salt']);
  }
  private payHost() {
    return baseUrl(this.ctx, 'https://testpay.easebuzz.in', 'https://pay.easebuzz.in');
  }
  private dashHost() {
    return baseUrl(this.ctx, 'https://testdashboard.easebuzz.in', 'https://dashboard.easebuzz.in', 'dashboard_url');
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const { key, salt } = this.creds;
    const c = req.customer ?? {};
    if (!c.mobile || !c.email || !c.name) throw new ProviderError('REJECTED', 'CUSTOMER_DETAILS_REQUIRED', 'Easebuzz needs the customer name, email and mobile', this.ctx.providerCode);
    if (!req.returnUrl) throw new ProviderError('CONFIGURATION', 'RETURN_URL_REQUIRED', 'Easebuzz needs a return URL', this.ctx.providerCode);
    const f: Record<string, string> = {
      key,
      txnid: req.reference,
      amount: rupees(req.amountMinor),
      productinfo: (req.description ?? 'Payment').replace(/[|]/g, ' ').slice(0, 100),
      firstname: c.name.replace(/[|]/g, ' ').slice(0, 60),
      email: c.email,
      phone: c.mobile,
      surl: req.returnUrl,
      furl: req.returnUrl,
      ...Object.fromEntries(UDF.map((u) => [u, ''])),
    };
    f.hash = sha512([f.key, f.txnid, f.amount, f.productinfo, f.firstname, f.email, ...UDF.map((u) => f[u]), salt].join('|'));
    const { body } = await call<{ status: number; data?: string; error_desc?: string }>(this.ctx, { baseUrl: this.payHost(), method: 'POST', path: '/payment/initiateLink', form: f });
    if (body.status !== 1 || !body.data) throw new ProviderError('REJECTED', 'INITIATE_FAILED', `Easebuzz refused the payment: ${body.error_desc ?? body.data ?? 'unknown error'}`, this.ctx.providerCode);
    const url = `${this.payHost()}/pay/${encodeURIComponent(body.data)}`;
    return { providerOrderId: req.reference, status: 'PENDING', paymentLink: url, action: { type: 'REDIRECT', url } };
  }

  async getPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    const { key, salt } = this.creds;
    const { body } = await call<{ status: boolean; msg: EbTxn | EbTxn[] | string }>(this.ctx, {
      baseUrl: this.dashHost(),
      method: 'POST',
      path: '/transaction/v2.1/retrieve',
      form: { key, txnid: providerOrderId, hash: sha512(`${key}|${providerOrderId}|${salt}`) },
    });
    const txns = Array.isArray(body.msg) ? body.msg : typeof body.msg === 'object' ? [body.msg] : [];
    if (!body.status || txns.length === 0) return { providerOrderId, status: 'PENDING' };
    // Several attempts can share a txnid; a success wins.
    const t = txns.find((x) => x.status?.toLowerCase() === 'success') ?? txns[txns.length - 1]!;
    return {
      providerOrderId,
      status: TXN_STATUS[t.status?.toLowerCase() ?? ''] ?? 'PENDING',
      amountMinor: toMinor(t.amount),
      providerTransactionId: t.easepayid,
      utr: t.bank_ref_num,
      payerVpa: t.upi_va,
      failureReason: t.error_Message,
    };
  }

  async refundPayment(req: RefundRequest): Promise<RefundResult> {
    const { key, salt } = this.creds;
    const easebuzzId = req.providerTransactionId ?? (await this.getPaymentStatus(req.providerOrderId)).providerTransactionId;
    if (!easebuzzId) return { providerRefundId: '', status: 'FAILED', failureReason: 'No Easebuzz transaction id for this payment' };
    const amount = rupees(req.amountMinor);
    const { body } = await call<{ status: boolean; refund_id?: string; reason?: string; message?: string }>(this.ctx, {
      baseUrl: this.dashHost(),
      method: 'POST',
      path: '/transaction/v2/refund',
      form: { key, merchant_refund_id: req.reference, easebuzz_id: easebuzzId, refund_amount: amount, hash: sha512(`${key}|${req.reference}|${easebuzzId}|${amount}|${salt}`) },
    });
    return body.status ? { providerRefundId: body.refund_id ?? req.reference, status: 'PENDING' } : { providerRefundId: '', status: 'FAILED', failureReason: body.reason ?? body.message ?? 'Refund refused' };
  }

  /** The response hash Easebuzz puts on callbacks and webhooks. */
  static responseHash(t: Record<string, string | undefined>, salt: string): string {
    const v = (k: string) => t[k] ?? '';
    return sha512([salt, v('status'), ...[...UDF].reverse().map(v), v('email'), v('firstname'), v('productinfo'), v('amount'), v('txnid'), v('key')].join('|'));
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookVerification {
    const { salt, key } = this.creds;
    const text = rawBody.toString('utf8').trim();
    const t: Record<string, string | undefined> = text.startsWith('{') ? (JSON.parse(text) as Record<string, string>) : formBody(rawBody);
    if (t.key !== key || !safeEqual(EasebuzzAdapter.responseHash(t, salt), t.hash?.toLowerCase())) return { valid: false, reason: 'hash mismatch' };
    void headers;
    return {
      valid: true,
      event: {
        externalEventId: `${t.easepayid ?? t.txnid}:${t.status}`,
        type: 'payment.status',
        reference: t.txnid,
        providerOrderId: t.txnid,
        status: TXN_STATUS[(t.status ?? '').toLowerCase()] ?? 'PENDING',
        amountMinor: toMinor(t.amount),
        utr: t.bank_ref_num,
        payerVpa: t.upi_va,
        failureReason: t.error_Message,
      },
    };
  }

  healthCheck(): Promise<HealthCheckResult> {
    // A lookup of an unknown txnid: answered (any status) means the key and hash were accepted.
    return timedHealth(async () => {
      const { key, salt } = this.creds;
      const { body } = await call<{ status: boolean; msg?: unknown; error_desc?: string }>(this.ctx, {
        baseUrl: this.dashHost(),
        method: 'POST',
        path: '/transaction/v2.1/retrieve',
        form: { key, txnid: 'HEALTHCHECK', hash: sha512(`${key}|HEALTHCHECK|${salt}`) },
      });
      const msg = JSON.stringify(body.msg ?? body.error_desc ?? '');
      if (/invalid (merchant|key|hash)|hash mismatch|authentication/i.test(msg)) throw new ProviderError('CONFIGURATION', 'INVALID_CREDENTIALS', `Easebuzz rejected the key or salt: ${msg.slice(0, 120)}`, this.ctx.providerCode);
    });
  }
}
