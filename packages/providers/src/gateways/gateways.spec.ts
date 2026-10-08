import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../interfaces/errors';
import type { ProviderContext } from '../interfaces/types';
import { payinAdapter } from '../registry';
import { ccavDecrypt, ccavEncrypt } from './ccavenue';
import { sha256, sha512 } from './common';
import { EasebuzzAdapter } from './easebuzz';
import { atomDecrypt, atomEncrypt, NttDataAdapter } from './nttdata';

/** One fake server for every gateway: records requests, answers from per-path handlers. */
type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
let handlers: Record<string, (r: Seen) => { status?: number; body: unknown; text?: boolean }> = {};
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const r: Seen = { method: req.method!, path: req.url!.split('?')[0]!, headers: req.headers, body: Buffer.concat(chunks).toString() };
      seen.push(r);
      const h = handlers[`${r.method} ${r.path}`];
      if (!h) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end('{"code":"not_found"}');
      }
      const out = h(r);
      res.writeHead(out.status ?? 200, { 'Content-Type': out.text ? 'text/plain' : 'application/json' });
      res.end(out.text ? String(out.body) : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
  handlers = {};
});

const ctx = (adapter: string, credentials: Record<string, string>, config: Record<string, unknown> = {}): ProviderContext => ({
  providerId: 'prv_TEST',
  providerCode: adapter,
  environment: 'TEST',
  credentials,
  // Every host the adapters can use points at the fake server: tests never reach a real gateway.
  config: { base_url: base, api_url: base, dashboard_url: base, auth_url: base, ...config },
  requestId: 'req_test',
  timeoutMs: 3000,
});
const req = { reference: 'pay_01JABCDEFGHJKMNPQRSTVWXYZ0', amountMinor: 123450n, currency: 'INR' as const, method: 'PAYMENT_LINK' as const, customer: { name: 'Asha Rao', email: 'asha@example.com', mobile: '9876543210' }, description: 'Order 42', expiresAt: new Date(Date.now() + 30 * 60_000), returnUrl: 'https://api.example.com/v1/checkout/return/pay_01JABCDEFGHJKMNPQRSTVWXYZ0', notifyUrl: 'https://api.example.com/v1/webhooks/providers/x' };

describe('Razorpay', () => {
  const creds = { key_id: 'rzp_test_abc', key_secret: 'sek', webhook_secret: 'whsec' };
  it('creates a payment link with Basic auth, paise and our reference; maps the status', async () => {
    handlers['POST /v1/payment_links'] = () => ({ body: { id: 'plink_1', short_url: 'https://rzp.io/i/x', status: 'created' } });
    const res = await payinAdapter('razorpay', ctx('razorpay', creds)).createPayment(req);
    expect(res).toMatchObject({ providerOrderId: 'plink_1', status: 'PENDING', action: { type: 'REDIRECT', url: 'https://rzp.io/i/x' } });
    expect(seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from('rzp_test_abc:sek').toString('base64')}`);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ amount: 123450, reference_id: req.reference, callback_url: req.returnUrl, callback_method: 'get' });
  });
  it('accepts only correctly signed webhooks', () => {
    const a = payinAdapter('razorpay', ctx('razorpay', creds));
    const body = Buffer.from(JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', reference_id: req.reference, status: 'paid' } }, payment: { entity: { id: 'pay_x', amount: 123450, status: 'captured', acquirer_data: { rrn: '123' } } } } }));
    const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(a.verifyWebhook(body, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' }).event).toMatchObject({ status: 'SUCCESS', providerOrderId: 'plink_1', reference: req.reference, amountMinor: 123450n, rrn: '123', externalEventId: 'evt_1' });
    expect(a.verifyWebhook(body, { 'x-razorpay-signature': sig.replace(/^./, '0') }).valid).toBe(false);
  });
  it('creates a multi-use, any-amount UPI QR and lists its captured credits', async () => {
    handlers['POST /v1/payments/qr_codes'] = () => ({ body: { id: 'qr_1', image_url: 'https://rzp.io/i/qr', image_content: 'upi://pay?pa=rpy.qr@icici&pn=Shop' } });
    handlers['GET /v1/payments/qr_codes/qr_1/payments'] = () => ({ body: { items: [{ id: 'pay_a', amount: 25000, status: 'captured', vpa: 'c@okaxis', acquirer_data: { rrn: '998877' }, created_at: 1767225600 }, { id: 'pay_b', amount: 100, status: 'failed' }] } });
    const a = payinAdapter('razorpay', ctx('razorpay', creds)) as unknown as import('../interfaces/types').StaticQrProvider;
    const qr = await a.createStaticQr({ reference: 'sqr_1', name: 'Sharma Electronics' });
    expect(qr).toEqual({ providerQrId: 'qr_1', upiPayload: 'upi://pay?pa=rpy.qr@icici&pn=Shop', imageUrl: 'https://rzp.io/i/qr' });
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ type: 'upi_qr', usage: 'multiple_use', fixed_amount: false, notes: { reference: 'sqr_1' } });
    const credits = await a.listStaticQrCredits('qr_1', new Date(1767225000_000));
    expect(credits).toEqual([{ providerPaymentId: 'pay_a', amountMinor: 25000n, rrn: '998877', utr: '998877', payerVpa: 'c@okaxis', paidAt: new Date(1767225600_000) }]);
    expect(seen[1]!.method).toBe('GET');
  });
  it('maps a signed qr_code.credited webhook to a static QR credit', () => {
    const a = payinAdapter('razorpay', ctx('razorpay', creds));
    const body = Buffer.from(JSON.stringify({ event: 'qr_code.credited', payload: { qr_code: { entity: { id: 'qr_1' } }, payment: { entity: { id: 'pay_a', amount: 25000, status: 'captured', vpa: 'c@okaxis', acquirer_data: { rrn: '998877' } } } } }));
    const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(a.verifyWebhook(body, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_q' }).event).toMatchObject({ type: 'static_qr.credit', providerQrId: 'qr_1', providerReference: 'pay_a', status: 'SUCCESS', amountMinor: 25000n, payerVpa: 'c@okaxis' });
  });
});

describe('Cashfree', () => {
  const creds = { client_id: 'cf_id', client_secret: 'cf_secret' };
  it('sends the API version and client headers; needs the customer phone', async () => {
    handlers['POST /pg/links'] = () => ({ body: { link_id: req.reference, link_url: 'https://payments-test.cashfree.com/links/x', link_status: 'ACTIVE' } });
    const a = payinAdapter('cashfree', ctx('cashfree', creds));
    expect((await a.createPayment(req)).status).toBe('PENDING');
    expect(seen[0]!.headers).toMatchObject({ 'x-client-id': 'cf_id', 'x-client-secret': 'cf_secret', 'x-api-version': '2023-08-01' });
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ link_id: req.reference, link_amount: 1234.5, link_meta: { return_url: req.returnUrl } });
    await expect(a.createPayment({ ...req, customer: { name: 'x' } })).rejects.toThrow(/mobile/);
  });
  it('verifies the base64 timestamp+body signature', () => {
    const a = payinAdapter('cashfree', ctx('cashfree', creds));
    const body = Buffer.from(JSON.stringify({ type: 'PAYMENT_LINK_EVENT', event_time: 't', data: { link_id: req.reference, link_status: 'PAID', link_amount_paid: 1234.5 } }));
    const sig = createHmac('sha256', 'cf_secret').update(`1700000000${body.toString()}`).digest('base64');
    expect(a.verifyWebhook(body, { 'x-webhook-timestamp': '1700000000', 'x-webhook-signature': sig }).event).toMatchObject({ status: 'SUCCESS', amountMinor: 123450n });
    expect(a.verifyWebhook(body, { 'x-webhook-timestamp': '1700000001', 'x-webhook-signature': sig }).valid).toBe(false);
  });
});

describe('Easebuzz', () => {
  const creds = { key: 'EBKEY', salt: 'EBSALT' };
  it('signs the initiate request with the documented SHA-512 sequence and redirects to /pay/<access key>', async () => {
    handlers['POST /payment/initiateLink'] = () => ({ body: { status: 1, data: 'acc123' } });
    const res = await payinAdapter('easebuzz', ctx('easebuzz', creds)).createPayment(req);
    expect(res.action).toEqual({ type: 'REDIRECT', url: `${base}/pay/acc123` });
    const f = Object.fromEntries(new URLSearchParams(seen[0]!.body));
    expect(f.hash).toBe(sha512(`EBKEY|${req.reference}|1234.50|Order 42|Asha Rao|asha@example.com|||||||||||EBSALT`));
    expect(seen[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });
  it('verifies the reverse hash on callbacks', () => {
    const a = payinAdapter('easebuzz', ctx('easebuzz', creds));
    const t: Record<string, string> = { key: 'EBKEY', txnid: req.reference, amount: '1234.50', productinfo: 'Order 42', firstname: 'Asha Rao', email: 'asha@example.com', status: 'success', easepayid: 'E1', bank_ref_num: 'B1' };
    t.hash = EasebuzzAdapter.responseHash(t, 'EBSALT');
    expect(t.hash).toBe(sha512(`EBSALT|success|||||||||||asha@example.com|Asha Rao|Order 42|1234.50|${req.reference}|EBKEY`));
    expect(a.verifyWebhook(Buffer.from(new URLSearchParams(t).toString()), {}).event).toMatchObject({ status: 'SUCCESS', amountMinor: 123450n, utr: 'B1' });
    expect(a.verifyWebhook(Buffer.from(new URLSearchParams({ ...t, amount: '1.00' }).toString()), {}).valid).toBe(false);
  });
});

describe('CCAvenue', () => {
  const creds = { merchant_id: '12345', access_code: 'AVXX', working_key: 'ABCDEF0123456789ABCDEF0123456789' };
  it('round-trips its AES-128-CBC format and builds an encrypted form post', async () => {
    expect(ccavDecrypt(ccavEncrypt('order_id=1&amount=10.00', creds.working_key), creds.working_key)).toBe('order_id=1&amount=10.00');
    const res = await payinAdapter('ccavenue', ctx('ccavenue', creds)).createPayment(req);
    expect(res.action?.type).toBe('FORM_POST');
    const fields = (res.action as { fields: Record<string, string> }).fields;
    const plain = Object.fromEntries(new URLSearchParams(ccavDecrypt(fields.encRequest!, creds.working_key)));
    expect(plain).toMatchObject({ merchant_id: '12345', order_id: res.providerOrderId, amount: '1234.50', redirect_url: req.returnUrl, merchant_param1: req.reference });
    expect(res.providerOrderId).not.toContain('_');
  });
  it('reads status from the API (never from the callback) and treats callbacks as a nudge', async () => {
    handlers['POST /apis/servlet/DoWebTrans'] = () => ({ text: true, body: `status=0&enc_response=${ccavEncrypt(JSON.stringify({ order_status: 'Shipped', reference_no: '1100', order_amt: 1234.5, order_bank_ref_no: 'BRN' }), creds.working_key)}` });
    const a = payinAdapter('ccavenue', ctx('ccavenue', creds));
    expect(await a.getPaymentStatus('ORDER1')).toMatchObject({ status: 'SUCCESS', providerTransactionId: '1100', amountMinor: 123450n });
    const cb = Buffer.from(`encResp=${ccavEncrypt('order_id=ORDER1&order_status=Success&tracking_id=1100', creds.working_key)}`);
    expect(a.verifyWebhook(cb, {}).event).toMatchObject({ providerOrderId: 'ORDER1', status: 'PENDING', confirmByStatusApi: true });
    expect(a.verifyWebhook(Buffer.from('encResp=00ff'), {}).valid).toBe(false);
  });
});

describe('HDFC SmartGateway', () => {
  const creds = { merchant_id: 'HDFCM', api_key: 'KEY1', payment_page_client_id: 'hdfcmaster', webhook_username: 'wh', webhook_password: 'pw' };
  it('opens a session with Basic api_key: and a 21-character order id', async () => {
    handlers['POST /session'] = (r) => ({ body: { id: 'ord_x', order_id: (JSON.parse(r.body) as { order_id: string }).order_id, status: 'NEW', payment_links: { web: 'https://smartgatewayuat.hdfcbank.com/orders/x/payment-page' } } });
    const res = await payinAdapter('hdfc', ctx('hdfc', creds)).createPayment(req);
    expect(res.providerOrderId).toHaveLength(21);
    expect(seen[0]!.headers).toMatchObject({ authorization: `Basic ${Buffer.from('KEY1:').toString('base64')}`, 'x-merchantid': 'HDFCM' });
  });
  it('maps CHARGED and checks the webhook Basic auth', async () => {
    handlers['GET /orders/ORD1'] = () => ({ body: { order_id: 'ORD1', status: 'CHARGED', amount: 1234.5, txn_id: 'T1' } });
    const a = payinAdapter('hdfc', ctx('hdfc', creds));
    expect(await a.getPaymentStatus('ORD1')).toMatchObject({ status: 'SUCCESS', amountMinor: 123450n });
    const body = Buffer.from(JSON.stringify({ id: 'evt1', event_name: 'ORDER_SUCCEEDED', content: { order: { order_id: 'ORD1', status: 'CHARGED', amount: 1234.5 } } }));
    expect(a.verifyWebhook(body, { authorization: `Basic ${Buffer.from('wh:pw').toString('base64')}` }).event).toMatchObject({ status: 'SUCCESS' });
    expect(a.verifyWebhook(body, { authorization: `Basic ${Buffer.from('wh:nope').toString('base64')}` }).valid).toBe(false);
  });
});

describe('PhonePe', () => {
  const creds = { client_id: 'PP_ID', client_secret: 'PP_SECRET', client_version: '1', webhook_username: 'u', webhook_password: 'p' };
  it('gets an O-Bearer token once, then creates the order', async () => {
    handlers['POST /v1/oauth/token'] = () => ({ body: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } });
    handlers['POST /checkout/v2/pay'] = () => ({ body: { orderId: 'OMO1', state: 'PENDING', redirectUrl: 'https://mercury-uat.phonepe.com/x' } });
    const a = payinAdapter('phonepe', ctx('phonepe', creds));
    await a.createPayment(req);
    await a.createPayment(req);
    expect(seen.filter((s) => s.path === '/v1/oauth/token')).toHaveLength(1);
    expect(seen.find((s) => s.path === '/checkout/v2/pay')!.headers.authorization).toBe('O-Bearer tok');
    expect(JSON.parse(seen.find((s) => s.path === '/checkout/v2/pay')!.body)).toMatchObject({ merchantOrderId: req.reference, amount: 123450, paymentFlow: { type: 'PG_CHECKOUT', merchantUrls: { redirectUrl: req.returnUrl } } });
  });
  it('verifies the SHA-256(username:password) webhook header', () => {
    const a = payinAdapter('phonepe', ctx('phonepe', creds));
    const body = Buffer.from(JSON.stringify({ event: 'checkout.order.completed', payload: { merchantOrderId: req.reference, orderId: 'OMO1', state: 'COMPLETED', amount: 123450, paymentDetails: [{ state: 'COMPLETED', rail: { utr: 'U1' } }] } }));
    expect(a.verifyWebhook(body, { authorization: sha256('u:p') }).event).toMatchObject({ status: 'SUCCESS', amountMinor: 123450n, utr: 'U1' });
    expect(a.verifyWebhook(body, { authorization: sha256('u:x') }).valid).toBe(false);
  });
});

describe('NTT DATA (Atom)', () => {
  const creds = { merch_id: '317157', password: 'Test@123', product_id: 'NSE', req_enc_key: 'A4476C2062FFA58980DC8F79EB6A799E', req_salt: 'A4476C2062FFA58980DC8F79EB6A799E', res_dec_key: '75AEF0FA1B94B3C10D4F5B268F757F11', res_salt: '75AEF0FA1B94B3C10D4F5B268F757F11', req_hash_key: 'KEY123657234', res_hash_key: 'KEYRESP123657234' };
  it('round-trips AIPAY encryption and returns a checkout token', async () => {
    expect(atomDecrypt(atomEncrypt('{"a":1}', creds.req_enc_key, creds.req_salt), creds.req_enc_key, creds.req_salt)).toBe('{"a":1}');
    handlers['POST /ots/aipay/auth'] = (r) => {
      const f = Object.fromEntries(new URLSearchParams(r.body));
      const sent = JSON.parse(atomDecrypt(f.encData!, creds.req_enc_key, creds.req_salt)) as { payInstrument: { payDetails: { amount: string } } };
      expect(sent.payInstrument.payDetails.amount).toBe('1234.50');
      return { text: true, body: `merchId=317157&encData=${atomEncrypt(JSON.stringify({ atomTokenId: 15000000085830, responseDetails: { txnStatusCode: 'OTS0000' } }), creds.res_dec_key, creds.res_salt)}` };
    };
    const res = await payinAdapter('nttdata', ctx('nttdata', creds)).createPayment(req);
    expect(res.action).toMatchObject({ type: 'ATOM_CHECKOUT', atomTokenId: '15000000085830', merchId: '317157' });
  });
  it('accepts only callbacks with a valid response signature', () => {
    const a = payinAdapter('nttdata', ctx('nttdata', creds));
    const r = { merchDetails: { merchId: 317157, merchTxnId: req.reference }, payDetails: { atomTxnId: 11000, totalAmount: 1234.5 } as Record<string, unknown>, payModeSpecificData: { subChannel: ['NB'], bankDetails: { bankTxnId: 'BTX' } }, responseDetails: { statusCode: 'OTS0000' } };
    r.payDetails.signature = NttDataAdapter.responseSignature(r, creds.res_hash_key);
    const enc = (o: unknown) => Buffer.from(`encData=${atomEncrypt(JSON.stringify({ payInstrument: o }), creds.res_dec_key, creds.res_salt)}&merchId=317157`);
    expect(a.verifyWebhook(enc(r), {}).event).toMatchObject({ status: 'SUCCESS', amountMinor: 123450n, utr: 'BTX' });
    expect(a.verifyWebhook(enc({ ...r, responseDetails: { statusCode: 'OTS0000' }, payDetails: { ...r.payDetails, totalAmount: 1 } }), {}).valid).toBe(false);
  });
});

describe('errors', () => {
  it('missing credentials are a configuration error, before any request', async () => {
    await expect(payinAdapter('razorpay', ctx('razorpay', {})).createPayment(req)).rejects.toBeInstanceOf(ProviderError);
    expect(seen).toHaveLength(0);
  });
});
