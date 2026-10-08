import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { ProviderError } from '../interfaces/errors';
import type { CreatePaymentRequest, CreatePaymentResult, HealthCheckResult, PayinProvider, PaymentProviderStatus, PaymentStatusResult, ProviderContext, RefundResult, WebhookVerification } from '../interfaces/types';
import { baseUrl, call, formBody, notSupported, requireCredentials, rupees, safeEqual, timedHealth, toMinor } from './common';

/**
 * NTT DATA Payment Services (Atom) — AIPAY. The AUTH call returns an atomTokenId that Atom's
 * checkout script opens; results come back as encData with an HMAC-SHA512 signature.
 * Crypto (per Atom's kits): AES-256-CBC, key = PBKDF2-HMAC-SHA512(encKey, salt, 65536, 32 bytes),
 * IV = bytes 0..15, hex. Separate key/salt pairs for requests and responses.
 * Docs: NTT DATA Payment Services integration kit (AIPAY / OTS v1.1).
 */
const IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const derived = new Map<string, Buffer>();
function aesKey(encKey: string, salt: string) {
  const k = `${encKey}\u0000${salt}`;
  let key = derived.get(k);
  if (!key) {
    key = pbkdf2Sync(encKey, salt, 65536, 32, 'sha512');
    derived.set(k, key);
  }
  return key;
}
export function atomEncrypt(plain: string, encKey: string, salt: string) {
  const c = createCipheriv('aes-256-cbc', aesKey(encKey, salt), IV);
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('hex').toUpperCase();
}
export function atomDecrypt(hex: string, encKey: string, salt: string) {
  const d = createDecipheriv('aes-256-cbc', aesKey(encKey, salt), IV);
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8');
}

const STATUS: Record<string, PaymentProviderStatus> = { OTS0000: 'SUCCESS', OTS0551: 'PENDING', OTS0101: 'FAILED', OTS0600: 'FAILED', OTS0201: 'FAILED', OTS0401: 'FAILED', OTS0451: 'FAILED' };

/** The ULID inside our ids carries its creation time — the original merchTxnDate, needed for status calls. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulidTime(reference: string): Date {
  const ulid = reference.split('_')[1] ?? '';
  let ms = 0;
  for (const ch of ulid.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(ch);
  return new Date(ms);
}
function istStamp(d: Date) {
  return new Date(d.getTime() + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

interface AtomResponse {
  merchDetails?: { merchId?: number | string; merchTxnId?: string };
  payDetails?: { atomTxnId?: number | string; amount?: number; totalAmount?: number; signature?: string };
  payModeSpecificData?: { subChannel?: string[] | string; bankDetails?: { bankTxnId?: string } };
  responseDetails?: { statusCode?: string; message?: string; description?: string };
}

export class NttDataAdapter implements PayinProvider {
  constructor(private readonly ctx: ProviderContext) {}

  private get c() {
    return requireCredentials(this.ctx, ['merch_id', 'password', 'product_id', 'req_enc_key', 'req_salt', 'res_dec_key', 'res_salt', 'req_hash_key', 'res_hash_key']);
  }
  private host() {
    return baseUrl(this.ctx, 'https://paynetzuat.atomtech.in', 'https://payment1.atomtech.in');
  }
  private async post<T>(path: string, payload: unknown): Promise<T> {
    const c = this.c;
    const { body } = await call<string>(this.ctx, { baseUrl: this.host(), method: 'POST', path, form: { encData: atomEncrypt(JSON.stringify(payload), c.req_enc_key, c.req_salt), merchId: c.merch_id }, responseType: 'text' });
    const enc = new URLSearchParams(body.trim()).get('encData');
    if (!enc) throw new ProviderError('AMBIGUOUS', 'MALFORMED_RESPONSE', `NTT DATA answered without encData: ${body.slice(0, 80)}`, this.ctx.providerCode);
    try {
      return JSON.parse(atomDecrypt(enc, c.res_dec_key, c.res_salt)) as T;
    } catch {
      throw new ProviderError('CONFIGURATION', 'DECRYPT_FAILED', 'Could not decrypt the NTT DATA response — check the response key and salt', this.ctx.providerCode);
    }
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const c = this.c;
    const cust = req.customer ?? {};
    if (!cust.email || !cust.mobile) throw new ProviderError('REJECTED', 'CUSTOMER_DETAILS_REQUIRED', 'NTT DATA needs the customer email and mobile', this.ctx.providerCode);
    if (!req.returnUrl) throw new ProviderError('CONFIGURATION', 'RETURN_URL_REQUIRED', 'NTT DATA needs a return URL', this.ctx.providerCode);
    const res = await this.post<{ atomTokenId?: number | string; responseDetails?: { txnStatusCode?: string; txnMessage?: string } }>('/ots/aipay/auth', {
      payInstrument: {
        headDetails: { version: 'OTSv1.1', api: 'AUTH', platform: 'FLASH' },
        merchDetails: { merchId: c.merch_id, userId: '', password: c.password, merchTxnId: req.reference, merchTxnDate: istStamp(ulidTime(req.reference)) },
        payDetails: { amount: rupees(req.amountMinor), product: c.product_id, custAccNo: '213232323', txnCurrency: 'INR' },
        custDetails: { custEmail: cust.email, custMobile: cust.mobile },
        extras: { udf1: req.reference, udf2: '', udf3: '', udf4: '', udf5: '' },
      },
    });
    if (res.responseDetails?.txnStatusCode !== 'OTS0000' || !res.atomTokenId) {
      throw new ProviderError('REJECTED', res.responseDetails?.txnStatusCode ?? 'AUTH_FAILED', `NTT DATA refused the payment: ${res.responseDetails?.txnMessage ?? 'no token'}`, this.ctx.providerCode);
    }
    const script = this.ctx.environment === 'LIVE' ? 'https://psa.atomtech.in/staticdata/ots/js/atomcheckout.js' : 'https://pgtest.atomtech.in/staticdata/ots/js/atomcheckout.js';
    return {
      providerOrderId: req.reference,
      status: 'PENDING',
      action: { type: 'ATOM_CHECKOUT', scriptUrl: (this.ctx.config.checkout_script_url as string) || script, atomTokenId: String(res.atomTokenId), merchId: c.merch_id, custEmail: cust.email, custMobile: cust.mobile, returnUrl: req.returnUrl },
    };
  }

  /** Signature Atom puts on responses: HMAC-SHA512 over merchId|atomTxnId|merchTxnId|totalAmount|statusCode|subChannel|bankTxnId (concatenated). */
  static responseSignature(r: AtomResponse, hashKey: string) {
    const sub = Array.isArray(r.payModeSpecificData?.subChannel) ? r.payModeSpecificData.subChannel[0] : (r.payModeSpecificData?.subChannel ?? '');
    const total = typeof r.payDetails?.totalAmount === 'number' ? r.payDetails.totalAmount.toFixed(2) : String(r.payDetails?.totalAmount ?? '');
    const s = `${r.merchDetails?.merchId ?? ''}${r.payDetails?.atomTxnId ?? ''}${r.merchDetails?.merchTxnId ?? ''}${total}${r.responseDetails?.statusCode ?? ''}${sub}${r.payModeSpecificData?.bankDetails?.bankTxnId ?? ''}`;
    return createHmac('sha512', hashKey).update(s).digest('hex');
  }

  async getPaymentStatus(providerOrderId: string, hint?: { amountMinor?: bigint }): Promise<PaymentStatusResult> {
    const c = this.c;
    const amount = hint?.amountMinor !== undefined ? rupees(hint.amountMinor) : '0.00';
    const api = 'TXNVERIFICATION';
    const res = await this.post<{ payInstrument?: AtomResponse[] | AtomResponse }>('/ots/payment/status', {
      payInstrument: {
        headDetails: { api, source: 'OTS' },
        merchDetails: { merchId: c.merch_id, password: c.password, merchTxnId: providerOrderId, merchTxnDate: istStamp(ulidTime(providerOrderId)).slice(0, 10) },
        payDetails: { amount, txnCurrency: 'INR', signature: createHmac('sha512', c.req_hash_key).update(`${c.merch_id}${c.password}${providerOrderId}${amount}INR${api}`).digest('hex') },
      },
    });
    const r = Array.isArray(res.payInstrument) ? res.payInstrument[0] : res.payInstrument;
    const code = r?.responseDetails?.statusCode ?? '';
    return {
      providerOrderId,
      status: STATUS[code] ?? 'PENDING',
      amountMinor: toMinor(r?.payDetails?.totalAmount ?? r?.payDetails?.amount),
      providerTransactionId: r?.payDetails?.atomTxnId !== undefined ? String(r.payDetails.atomTxnId) : undefined,
      utr: r?.payModeSpecificData?.bankDetails?.bankTxnId,
      failureReason: STATUS[code] === 'FAILED' ? (r?.responseDetails?.description ?? r?.responseDetails?.message ?? code) : undefined,
    };
  }

  refundPayment(): Promise<RefundResult> {
    return notSupported(this.ctx, 'refund by API (refund from the NTT DATA merchant dashboard)');
  }

  verifyWebhook(rawBody: Buffer): WebhookVerification {
    const c = this.c;
    const enc = formBody(rawBody).encData;
    if (!enc) return { valid: false, reason: 'missing encData' };
    let r: AtomResponse;
    try {
      const parsed = JSON.parse(atomDecrypt(enc, c.res_dec_key, c.res_salt)) as { payInstrument?: AtomResponse };
      r = parsed.payInstrument ?? (parsed as AtomResponse);
    } catch {
      return { valid: false, reason: 'cannot decrypt' };
    }
    if (!safeEqual(NttDataAdapter.responseSignature(r, c.res_hash_key), r.payDetails?.signature)) return { valid: false, reason: 'signature mismatch' };
    const code = r.responseDetails?.statusCode ?? '';
    return {
      valid: true,
      event: {
        externalEventId: `${r.payDetails?.atomTxnId ?? r.merchDetails?.merchTxnId}:${code}`,
        type: 'payment.status',
        reference: r.merchDetails?.merchTxnId,
        providerOrderId: r.merchDetails?.merchTxnId,
        status: STATUS[code] ?? 'PENDING',
        amountMinor: toMinor(r.payDetails?.totalAmount),
        utr: r.payModeSpecificData?.bankDetails?.bankTxnId,
        failureReason: r.responseDetails?.description,
      },
    };
  }

  healthCheck(): Promise<HealthCheckResult> {
    // A status call for a reference that doesn't exist still has to decrypt and sign correctly.
    return timedHealth(() => this.getPaymentStatus('pay_00000000000000000000000000'));
  }
}
