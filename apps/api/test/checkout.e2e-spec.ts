import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ccavEncrypt } from '@pay2all/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let superAdmin: string;
let compliance: string;
let fake: http.Server;
let fakeUrl: string;
const reason = 'Checkout e2e test';
const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const rzp = { key_id: 'rzp_test_e2e', key_secret: 'secret_e2e', webhook_secret: 'whsec_e2e' };
const ccav = { merchant_id: '99999', access_code: 'AVTEST00', working_key: 'ABCDEF0123456789ABCDEF0123456789' };

/** A fake Razorpay + CCAvenue: links are "paid" when the test says so. */
const links = new Map<string, { reference: string; amount: number; status: string }>();
let ccavStatus = 'Aborted';

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const json = (o: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const path = req.url!.split('?')[0]!;
      if (req.headers.authorization && req.headers.authorization !== `Basic ${Buffer.from(`${rzp.key_id}:${rzp.key_secret}`).toString('base64')}`) return json({ error: { code: 'BAD_REQUEST_ERROR' } }, 401);
      if (req.method === 'GET' && path === '/v1/payment_links') return json({ count: 0, payment_links: [] });
      if (req.method === 'POST' && path === '/v1/payment_links') {
        const b = JSON.parse(body) as { reference_id: string; amount: number };
        const id = `plink_${b.reference_id.slice(-10)}`;
        links.set(id, { reference: b.reference_id, amount: b.amount, status: 'created' });
        return json({ id, short_url: `${fakeUrl}/pay/${id}`, status: 'created' });
      }
      const m = /^\/v1\/payment_links\/(plink_\w+)$/.exec(path);
      if (req.method === 'GET' && m) {
        const l = links.get(m[1]!);
        return l ? json({ id: m[1], status: l.status, amount_paid: l.status === 'paid' ? l.amount : 0, payments: l.status === 'paid' ? [{ payment_id: 'pay_rzp1', amount: l.amount, status: 'captured' }] : [] }) : json({}, 404);
      }
      if (req.method === 'GET' && path === '/v1/payments/pay_rzp1') return json({ id: 'pay_rzp1', amount: 0, status: 'captured', acquirer_data: { rrn: '412345678901' } });
      if (req.method === 'POST' && path === '/apis/servlet/DoWebTrans') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(`status=0&enc_response=${ccavEncrypt(JSON.stringify({ order_status: ccavStatus, reference_no: '3100', order_amt: 500 }), ccav.working_key)}`);
      }
      json({ error: 'not found' }, 404);
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  superAdmin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id })).email)).accessToken;
  compliance = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'COMPLIANCE', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  // Leave no gateway enabled for other suites.
  await ctx.prisma.providerRoute.updateMany({ where: { provider: { code: { in: ['razorpay', 'ccavenue'] } } }, data: { isActive: false } });
  await ctx.prisma.provider.updateMany({ where: { code: { in: ['razorpay', 'ccavenue'] } }, data: { status: 'DISABLED' } });
  await ctx.app.close();
  await new Promise<void>((r) => fake.close(() => r()));
});

/** Point a connected gateway at the fake server (admins can't set hosts; tests can). */
async function pointAtFake(code: string) {
  const p = await ctx.prisma.provider.findUniqueOrThrow({ where: { code } });
  await ctx.prisma.provider.update({ where: { id: p.id }, data: { config: { ...(p.config as object), base_url: fakeUrl, api_url: fakeUrl } } });
}

async function merchantWithWebsite() {
  const m = await createApprovedMerchant(ctx);
  const w = await ctx.http().post('/v1/checkout/websites').set(bearer(m.owner)).send({ url: 'https://shop.example.com/cart' });
  expect(w.body.data).toMatchObject({ url: 'https://shop.example.com', status: 'PENDING' });
  return { ...m, websiteId: w.body.data.id as string };
}

describe('payment gateways (super admin)', () => {
  it('lists every supported gateway with its webhook URL; never returns credentials', async () => {
    const res = await ctx.http().get('/v1/gateways').set(bearer(superAdmin));
    expect(res.body.data.map((g: { key: string }) => g.key)).toEqual(['razorpay', 'cashfree', 'easebuzz', 'ccavenue', 'hdfc', 'nttdata', 'phonepe']);
    expect(res.body.data[0].webhook_url).toMatch(/\/v1\/webhooks\/providers\/razorpay$/);
  });

  it('connect → test → enable; credentials are write-only, enabling needs a passing test', async () => {
    const save = await ctx.http().put('/v1/gateways/razorpay').set(bearer(superAdmin)).send({ environment: 'TEST', credentials: rzp, reason });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.body)).not.toContain('secret_e2e');
    expect(save.body.data.connection.credentials.TEST.fingerprints).toMatchObject({ key_secret: '…_e2e' });
    expect((await ctx.http().post('/v1/gateways/razorpay/enabled').set(bearer(superAdmin)).send({ enabled: true, reason })).status).toBe(400);

    await pointAtFake('razorpay');
    const test = await ctx.http().post('/v1/gateways/razorpay/test').set(bearer(superAdmin));
    expect(test.body.data).toMatchObject({ ok: true, environment: 'TEST' });
    const on = await ctx.http().post('/v1/gateways/razorpay/enabled').set(bearer(superAdmin)).send({ enabled: true, reason });
    expect(on.body.data.connection).toMatchObject({ enabled: true, status: 'ACTIVE' });

    // A wrong secret fails the test (and the old pass no longer counts).
    await ctx.http().put('/v1/gateways/razorpay').set(bearer(superAdmin)).send({ environment: 'TEST', credentials: { key_secret: 'wrong' }, reason }).expect(200);
    expect((await ctx.http().post('/v1/gateways/razorpay/test').set(bearer(superAdmin))).body.data.ok).toBe(false);
    await ctx.http().put('/v1/gateways/razorpay').set(bearer(superAdmin)).send({ environment: 'TEST', credentials: { key_secret: rzp.key_secret }, reason }).expect(200);
    expect((await ctx.http().post('/v1/gateways/razorpay/test').set(bearer(superAdmin))).body.data.ok).toBe(true);
  });

  it('only super admins manage gateways', async () => {
    const platform = await orgBySlug(ctx, 'pay2all');
    const admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
    expect((await ctx.http().put('/v1/gateways/cashfree').set(bearer(admin)).send({ environment: 'TEST', credentials: { client_id: 'x', client_secret: 'y' }, reason })).status).toBe(403);
    expect((await ctx.http().put('/v1/gateways/nope').set(bearer(superAdmin)).send({ environment: 'TEST', credentials: {}, reason })).status).toBe(404);
    expect((await ctx.http().put('/v1/gateways/razorpay').set(bearer(superAdmin)).send({ environment: 'TEST', credentials: { api_key: 'x' }, reason })).status).toBe(400);
  });
});

describe('websites', () => {
  it('merchant adds a website; checkout refuses it until compliance approves', async () => {
    const m = await merchantWithWebsite();
    const body = { merchant_order_id: 'ORD-1', amount: '500.00', return_url: 'https://shop.example.com/thanks' };
    const pending = await ctx.http().post('/v1/checkout/sessions').set(bearer(m.owner)).set('Idempotency-Key', key()).send(body);
    expect(pending.status).toBe(400);
    expect(pending.body.error.message).toMatch(/waiting for approval/);
    expect((await ctx.http().post('/v1/checkout/sessions').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ ...body, return_url: 'https://evil.example.net/x' })).body.error.message).toMatch(/not one of your websites/);

    expect((await ctx.http().post(`/v1/admin/websites/${m.websiteId}/review`).set(bearer(compliance)).send({ decision: 'REJECT' })).status).toBe(400);
    await ctx.http().post(`/v1/admin/websites/${m.websiteId}/review`).set(bearer(compliance)).send({ decision: 'APPROVE' }).expect(200);
    expect((await ctx.http().post('/v1/checkout/sessions').set(bearer(m.owner)).set('Idempotency-Key', key()).send(body)).status).toBe(201);
    expect((await ctx.http().post('/v1/checkout/sessions').set(bearer(m.owner)).set('Idempotency-Key', key()).send(body)).status).toBe(409); // one checkout per order
    expect((await ctx.http().post(`/v1/checkout/websites/${m.websiteId}/remove`).set(bearer(m.owner))).status).toBe(409); // in use
  });
});

describe('hosted checkout', () => {
  async function session(amount = '500.00') {
    const m = await merchantWithWebsite();
    await ctx.http().post(`/v1/admin/websites/${m.websiteId}/review`).set(bearer(compliance)).send({ decision: 'APPROVE' }).expect(200);
    const s = await ctx.http().post('/v1/checkout/sessions').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: `ORD-${Date.now()}`, amount, description: 'Blue kurta', return_url: 'https://shop.example.com/thanks?x=1' });
    expect(s.status).toBe(201);
    const token = new URL(s.body.data.url as string).pathname.split('/').pop()!;
    return { m, id: s.body.data.id as string, token, order: s.body.data.merchant_order_id as string };
  }
  const customer = { name: 'Asha Rao', email: 'asha@example.com', mobile: '9876543210' };

  it('the public page shows the order and the available methods, nothing else', async () => {
    const { token } = await session();
    const v = await ctx.http().get(`/v1/public/checkout/${token}`);
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ order: { amount: '500.00', description: 'Blue kurta' }, status: 'OPEN', methods: { upi: true } });
    expect(v.body.data.methods.gateways[0]).toMatchObject({ key: 'GATEWAY' });
    expect(JSON.stringify(v.body)).not.toMatch(/merchant_id|org_/);
    expect((await ctx.http().get('/v1/public/checkout/not-a-real-token-but-long-enough-000000')).status).toBe(404);
  });

  it('UPI: shows a QR; paying it marks the session PAID and sends the customer back with the outcome', async () => {
    const { m, id, token, order } = await session();
    const pay = await ctx.http().post(`/v1/public/checkout/${token}/pay`).send({ method: 'UPI', customer });
    expect(pay.status).toBe(200);
    expect(pay.body.data.qr_payload).toMatch(/^upi:\/\/pay\?/);
    // Asking again shows the same open request instead of a new one.
    expect((await ctx.http().post(`/v1/public/checkout/${token}/pay`).send({ method: 'UPI', customer })).body.data.id).toBe(pay.body.data.id);

    await ctx.http().post(`/v1/sandbox/payments/${pay.body.data.id}/complete`).set(bearer(m.owner)).send({ outcome: 'SUCCESS' }).expect(200);
    const st = await ctx.http().get(`/v1/public/checkout/${token}/status`);
    expect(st.body.data.status).toBe('PAID');
    const back = new URL(st.body.data.return_url as string);
    expect(Object.fromEntries(back.searchParams)).toEqual({ x: '1', checkout_session_id: id, merchant_order_id: order, status: 'PAID' });

    const merchantView = await ctx.http().get(`/v1/checkout/sessions/${id}`).set(bearer(m.owner));
    expect(merchantView.body.data).toMatchObject({ status: 'PAID', payment: { status: 'SUCCESS' } });
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: pay.body.data.id as string } });
    expect(p).toMatchObject({ merchantOrderId: `${order}#1`, checkoutSessionId: id });
    expect((await ctx.http().post(`/v1/public/checkout/${token}/pay`).send({ method: 'UPI', customer })).status).toBe(409);
  });

  it('Cards via Razorpay: redirect, signed webhook, return → PAID', async () => {
    const { token, id } = await session('1250.00');
    const pay = await ctx.http().post(`/v1/public/checkout/${token}/pay`).send({ method: 'GATEWAY', customer });
    expect(pay.status).toBe(200);
    expect(pay.body.data.action).toMatchObject({ type: 'REDIRECT' });
    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: pay.body.data.id as string }, include: { attempts: true } });
    expect(payment.providerOrderId).toMatch(/^plink_/);

    // Customer returns before the webhook: the return endpoint asks Razorpay (still unpaid) and shows the page.
    const early = await ctx.http().get(`/v1/checkout/return/${payment.id}`).redirects(0);
    expect(early.status).toBe(303);
    expect(early.headers.location).toMatch(new RegExp(`/checkout/${token}\\?returned=1$`));
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PENDING');

    // Razorpay's signed webhook marks it paid; an unsigned copy is refused.
    links.get(payment.providerOrderId!)!.status = 'paid';
    const event = Buffer.from(JSON.stringify({ event: 'payment_link.paid', created_at: 1, payload: { payment_link: { entity: { id: payment.providerOrderId, reference_id: payment.id, status: 'paid' } }, payment: { entity: { id: 'pay_rzp1', amount: 125000, status: 'captured', acquirer_data: { rrn: '412345678901' } } } } }));
    const unsigned = await ctx.http().post('/v1/webhooks/providers/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', 'deadbeef').send(event.toString());
    expect(unsigned.status).toBe(401);
    const signed = await ctx.http().post('/v1/webhooks/providers/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', createHmac('sha256', rzp.webhook_secret).update(event).digest('hex')).set('X-Razorpay-Event-Id', `evt_${payment.id}`).send(event.toString());
    expect(signed.status).toBe(200);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('SUCCESS');
    expect((await ctx.prisma.checkoutSession.findUniqueOrThrow({ where: { id } })).status).toBe('PAID');
  });

  it('CCAvenue: a form-post hand-off page with a strict CSP; a tampered callback can never mark it paid', async () => {
    await ctx.http().put('/v1/gateways/ccavenue').set(bearer(superAdmin)).send({ environment: 'TEST', credentials: ccav, priority: 5, reason }).expect(200);
    await pointAtFake('ccavenue');
    expect((await ctx.http().post('/v1/gateways/ccavenue/test').set(bearer(superAdmin))).body.data.ok).toBe(true);
    await ctx.http().post('/v1/gateways/ccavenue/enabled').set(bearer(superAdmin)).send({ enabled: true, reason }).expect(200);

    const { token } = await session('500.00');
    const pay = await ctx.http().post(`/v1/public/checkout/${token}/pay`).send({ method: 'GATEWAY', customer });
    expect(pay.body.data.action.type).toBe('FORM_POST');
    const page = await ctx.http().get(`/v1/checkout/pay/${pay.body.data.id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('name="encRequest"');
    // Forms may only go to the gateway (the fake server here; test.ccavenue.com for real).
    expect(page.headers['content-security-policy']).toContain(`form-action ${fakeUrl}`);
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-/);

    // The callback claims Success, but the Order Status API says Aborted: the API wins.
    ccavStatus = 'Aborted';
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: pay.body.data.id as string } });
    const forged = `encResp=${ccavEncrypt(`order_id=${p.providerOrderId}&order_status=Success&tracking_id=1`, ccav.working_key)}`;
    await ctx.http().post('/v1/webhooks/providers/ccavenue').set('Content-Type', 'application/x-www-form-urlencoded').send(forged).expect(200);
    await ctx.http().post(`/v1/checkout/return/${p.id}`).set('Content-Type', 'application/x-www-form-urlencoded').send(forged).redirects(0).expect(303);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('FAILED');

    await ctx.http().post('/v1/gateways/ccavenue/enabled').set(bearer(superAdmin)).send({ enabled: false, reason }).expect(200);
  });

  it('expired, cancelled and attempt-limited sessions refuse payment', async () => {
    const { m, id, token } = await session();
    await ctx.http().post(`/v1/checkout/sessions/${id}/cancel`).set(bearer(m.owner)).expect(200);
    expect((await ctx.http().post(`/v1/public/checkout/${token}/pay`).send({ method: 'UPI', customer })).status).toBe(409);
    const b = await session();
    await ctx.prisma.checkoutSession.update({ where: { id: b.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await ctx.http().get(`/v1/public/checkout/${b.token}`)).body.data.status).toBe('EXPIRED');
    expect((await ctx.http().post(`/v1/public/checkout/${b.token}/pay`).send({ method: 'UPI', customer })).status).toBe(409);
    expect((await ctx.http().post(`/v1/public/checkout/${b.token}/pay`).send({ method: 'UPI', customer: { ...customer, email: 'nope' } })).status).toBe(400);
  });

  it('merchants see only their own checkouts', async () => {
    const a = await session();
    const other = await createApprovedMerchant(ctx);
    expect((await ctx.http().get(`/v1/checkout/sessions/${a.id}`).set(bearer(other.owner))).status).toBe(404);
    expect((await ctx.http().get('/v1/checkout/sessions').set(bearer(other.owner))).body.data).toHaveLength(0);
  });
});
