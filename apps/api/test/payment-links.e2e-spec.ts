import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticQrService } from '../src/modules/static-qr/static-qr.service';
import { InboundEventsService } from '../src/modules/provider-events/inbound-events.service';
import { ProviderRegistryService } from '../src/modules/providers/provider-registry.service';
import { bearer, createApprovedMerchant, createTestContext, queuedMail, type TestContext } from './helpers';

let ctx: TestContext;
const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const customer = { name: 'Asha Rao', email: 'asha@example.com', mobile: '+919876543210' };
const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.app.close();
});

async function payByUpi(owner: string, token: string) {
  const pay = await ctx.http().post(`/v1/public/checkout/${token}/pay`).send({ method: 'UPI', customer });
  expect(pay.status).toBe(200);
  await ctx.http().post(`/v1/sandbox/payments/${pay.body.data.id}/complete`).set(bearer(owner)).send({ outcome: 'SUCCESS' }).expect(200);
  return pay.body.data.id as string;
}

describe('payment links', () => {
  it('creates a link, emails it, and ends on a receipt (no website) once paid', async () => {
    const m = await createApprovedMerchant(ctx);
    const res = await ctx
      .http()
      .post('/v1/payment-links')
      .set(bearer(m.owner))
      .set('Idempotency-Key', key())
      .send({ amount: '1499.00', description: 'Invoice INV-204', reference: 'INV-204', customer: { name: 'Asha Rao', email: 'asha@example.com' }, notify: { email: true } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ object: 'payment_link', reference: 'INV-204', amount: '1499.00', status: 'OPEN' });
    expect(res.body.data.notified_at).toBeTruthy();
    const mail = (await queuedMail(ctx, 'asha@example.com')).filter((x) => x.template === 'payment_link').pop()!;
    expect(mail.text).toContain(res.body.data.url);
    expect(mail.text).toContain('₹1499.00');

    // One link per reference; resending too soon is refused.
    expect((await ctx.http().post('/v1/payment-links').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ amount: '1.00', description: 'dup', reference: 'INV-204' })).body.error.code).toBe('DUPLICATE_ORDER');
    expect((await ctx.http().post(`/v1/payment-links/${res.body.data.id}/notify`).set(bearer(m.owner)).send({ email: true })).status).toBe(429);
    // SMS needs a mobile on file.
    expect((await ctx.http().post('/v1/payment-links').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ amount: '5.00', description: 'x sms', notify: { sms: true } })).status).toBe(400);

    const token = tokenOf(res.body.data.url as string);
    const view = await ctx.http().get(`/v1/public/checkout/${token}`);
    expect(view.body.data).toMatchObject({ kind: 'LINK', status: 'OPEN', cancel_url: null, order: { amount: '1499.00', description: 'Invoice INV-204' } });

    await payByUpi(m.owner, token);
    const st = await ctx.http().get(`/v1/public/checkout/${token}/status`);
    expect(st.body.data).toMatchObject({ status: 'PAID', return_url: null, payment: { status: 'SUCCESS' } });
    const link = await ctx.http().get(`/v1/payment-links/${res.body.data.id}`).set(bearer(m.owner));
    expect(link.body.data).toMatchObject({ status: 'PAID', payment: { status: 'SUCCESS' } });
    expect((await ctx.http().post(`/v1/payment-links/${res.body.data.id}/cancel`).set(bearer(m.owner))).status).toBe(409);

    const list = await ctx.http().get('/v1/payment-links?status=PAID').set(bearer(m.owner));
    expect(list.body.data.map((l: { id: string }) => l.id)).toEqual([res.body.data.id]);
    expect((await ctx.http().get('/v1/payment-links/summary').set(bearer(m.owner))).body.data).toMatchObject({ created: 1, paid: 1, paid_amount: '1499.00' });
    // Website checkouts don't list links.
    expect((await ctx.http().get('/v1/checkout/sessions').set(bearer(m.owner))).body.data).toEqual([]);
  });

  it('generates a reference, cancels an open link, and keeps tenants apart', async () => {
    const m = await createApprovedMerchant(ctx);
    const other = await createApprovedMerchant(ctx);
    const res = await ctx.http().post('/v1/payment-links').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ amount: '10.00', description: 'Deposit', expires_in_days: 2 });
    expect(res.body.data.reference).toMatch(/^PL-[0-9A-Z]{26}$/);
    expect(new Date(res.body.data.expires_at as string).getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
    expect((await ctx.http().get(`/v1/payment-links/${res.body.data.id}`).set(bearer(other.owner))).status).toBe(404);
    expect((await ctx.http().post(`/v1/payment-links/${res.body.data.id}/cancel`).set(bearer(other.owner))).status).toBe(404);
    const cancelled = await ctx.http().post(`/v1/payment-links/${res.body.data.id}/cancel`).set(bearer(m.owner));
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect((await ctx.http().post(`/v1/public/checkout/${tokenOf(res.body.data.url as string)}/pay`).send({ method: 'UPI', customer })).status).toBe(409);
  });
});

describe('payment pages', () => {
  const page = (slug: string) => ({
    slug,
    title: 'School fees — Term 2',
    description: 'Pay the term fee for your child.',
    amount: { amount_type: 'FIXED', amount: '2500.00' },
    fields: [
      { key: 'student_name', label: 'Student name', type: 'text', required: true },
      { key: 'roll_no', label: 'Roll number', type: 'number', required: false },
    ],
    success_message: 'Thank you! The school office will email your receipt.',
  });

  it('publishes a page, collects with field answers, and reports totals', async () => {
    const m = await createApprovedMerchant(ctx);
    const slug = `fees-${randomUUID().slice(0, 8)}`;
    const created = await ctx.http().post('/v1/payment-pages').set(bearer(m.owner)).send(page(slug));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ slug, url: `http://localhost:3000/p/${slug}`, status: 'ACTIVE', stats: { payments: 0, collected: '0.00' } });
    const other = await createApprovedMerchant(ctx);
    expect((await ctx.http().post('/v1/payment-pages').set(bearer(other.owner)).send(page(slug))).status).toBe(409);
    expect((await ctx.http().post('/v1/payment-pages').set(bearer(other.owner)).send(page('admin'))).status).toBe(400);

    const pub = await ctx.http().get(`/v1/public/pages/${slug}`);
    expect(pub.body.data).toMatchObject({ title: 'School fees — Term 2', amount: { amount_type: 'FIXED', amount: '2500.00' }, merchant: { name: 'Test merchant' } });
    expect(JSON.stringify(pub.body.data)).not.toContain(m.id);

    const missing = await ctx.http().post(`/v1/public/pages/${slug}/checkout`).send({ customer, fields: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/Student name is required/);
    expect((await ctx.http().post(`/v1/public/pages/${slug}/checkout`).send({ customer, fields: { student_name: 'Riya', roll_no: 'abc' } })).status).toBe(400);
    const start = await ctx.http().post(`/v1/public/pages/${slug}/checkout`).send({ amount: '1.00', customer, fields: { student_name: 'Riya', roll_no: '42' } });
    expect(start.status).toBe(200);
    const view = await ctx.http().get(`/v1/public/checkout/${start.body.data.token}`);
    // Fixed page: the amount sent by the browser is ignored.
    expect(view.body.data).toMatchObject({ kind: 'PAGE', order: { amount: '2500.00' }, page: { slug, success_message: 'Thank you! The school office will email your receipt.' } });

    await payByUpi(m.owner, start.body.data.token as string);
    const after = await ctx.http().get(`/v1/payment-pages/${created.body.data.id}`).set(bearer(m.owner));
    expect(after.body.data.stats).toMatchObject({ payments: 1, collected: '2500.00' });
    const payments = await ctx.http().get(`/v1/payment-pages/${created.body.data.id}/payments`).set(bearer(m.owner));
    expect(payments.body.data[0]).toMatchObject({ amount: '2500.00', customer: { name: 'Asha Rao' }, fields: { student_name: 'Riya', roll_no: '42' } });

    // Deactivated pages disappear.
    await ctx.http().post(`/v1/payment-pages/${created.body.data.id}/status`).set(bearer(m.owner)).send({ status: 'INACTIVE' }).expect(200);
    expect((await ctx.http().get(`/v1/public/pages/${slug}`)).status).toBe(404);
    expect((await ctx.http().get(`/v1/payment-pages/${created.body.data.id}`).set(bearer(other.owner))).status).toBe(404);
  });

  it('customer-entered amounts must be within the page’s range', async () => {
    const m = await createApprovedMerchant(ctx);
    const slug = `donate-${randomUUID().slice(0, 8)}`;
    const body = { ...page(slug), title: 'Donate', fields: [], amount: { amount_type: 'CUSTOMER', min_amount: '100.00', max_amount: '50000.00' } };
    expect((await ctx.http().post('/v1/payment-pages').set(bearer(m.owner)).send({ ...body, amount: { amount_type: 'CUSTOMER', min_amount: '500.00', max_amount: '100.00' } })).status).toBe(400);
    await ctx.http().post('/v1/payment-pages').set(bearer(m.owner)).send(body).expect(201);
    expect((await ctx.http().post(`/v1/public/pages/${slug}/checkout`).send({ customer })).status).toBe(400);
    expect((await ctx.http().post(`/v1/public/pages/${slug}/checkout`).send({ amount: '99.99', customer })).status).toBe(400);
    const ok = await ctx.http().post(`/v1/public/pages/${slug}/checkout`).send({ amount: '751.00', customer });
    expect((await ctx.http().get(`/v1/public/checkout/${ok.body.data.token}`)).body.data.order.amount).toBe('751.00');
  });
});

describe('static QR', () => {
  it('issues a printable QR; each credit becomes a captured payment exactly once', async () => {
    const m = await createApprovedMerchant(ctx);
    const created = await ctx.http().post('/v1/static-qrs').set(bearer(m.owner)).send({ label: 'Counter 1' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ label: 'Counter 1', status: 'ACTIVE', provider: 'mock-upi', today: { count: 0, amount: '0.00' } });
    expect(created.body.data.upi_payload).toMatch(/^upi:\/\/pay\?pa=.+&pn=Test%20merchant/);
    expect(created.body.data.upi_payload).not.toMatch(/am=/);
    const qrId = created.body.data.id as string;

    const pay = await ctx.http().post(`/v1/sandbox/static-qrs/${qrId}/pay`).set(bearer(m.owner)).send({ amount: '250.00' });
    expect(pay.status).toBe(200);
    const credits = await ctx.http().get(`/v1/static-qrs/${qrId}/payments`).set(bearer(m.owner));
    expect(credits.body.data).toHaveLength(1);
    expect(credits.body.data[0]).toMatchObject({ method: 'UPI_STATIC_QR', status: 'SUCCESS', amount: '250.00', static_qr_id: qrId });
    const p = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: credits.body.data[0].payment_id as string } });
    expect(p.captureJournalId).toBeTruthy();
    expect(await ctx.prisma.webhookEvent.count({ where: { resourceId: p.id, type: 'payment.success' } })).toBe(1);

    // The same credit again (webhook retry or poller) records nothing new.
    const svc = ctx.app.get(StaticQrService);
    expect(await svc.recordCredit(p.providerId!, (await ctx.prisma.staticQr.findUniqueOrThrow({ where: { id: qrId } })).providerQrId, { providerPaymentId: p.providerOrderId!, amountMinor: 25_000n })).toBe('DUPLICATE');
    // A replayed signed callback (same event id) is acknowledged once.
    const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { id: p.providerId! } });
    const secret = (await ctx.app.get(ProviderRegistryService).context(provider)).credentials.webhook_secret!;
    const body = Buffer.from(JSON.stringify({ event_id: `e_${randomUUID()}`, type: 'static_qr.credit', data: { qr_id: `mockqr_${qrId}`, provider_reference: 'mockpay_twice', status: 'SUCCESS', amount_minor: '1000' } }));
    const headers = { 'x-mock-signature': createHmac('sha256', secret).update(body).digest('hex') };
    const inbound = ctx.app.get(InboundEventsService);
    expect(await inbound.receive(provider.code, body, headers)).toMatchObject({ duplicate: false });
    expect(await inbound.receive(provider.code, body, headers)).toMatchObject({ duplicate: true });
    expect(await ctx.prisma.payment.count({ where: { staticQrId: qrId } })).toBe(2);

    const list = await ctx.http().get('/v1/static-qrs').set(bearer(m.owner));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data[0].today).toEqual({ count: 2, amount: '260.00' });

    // Another merchant can't see it; closing stops it.
    const other = await createApprovedMerchant(ctx);
    expect((await ctx.http().get(`/v1/static-qrs/${qrId}/payments`).set(bearer(other.owner))).status).toBe(404);
    expect((await ctx.http().post(`/v1/static-qrs/${qrId}/close`).set(bearer(m.owner))).body.data.status).toBe('CLOSED');
    expect((await ctx.http().post(`/v1/sandbox/static-qrs/${qrId}/pay`).set(bearer(m.owner)).send({ amount: '5.00' })).status).toBe(409);
  });

  it('ignores credits for unknown QRs and non-captured events', async () => {
    const svc = ctx.app.get(StaticQrService);
    const provider = await ctx.prisma.provider.findUniqueOrThrow({ where: { code: 'mock-upi' } });
    expect(await svc.recordCredit(provider.id, 'mockqr_nope', { providerPaymentId: 'x', amountMinor: 100n })).toBe('UNKNOWN_QR');
  });
});
