import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createApprovedMerchant, createTestContext, extractRefreshCookie, queuedMail, randomIp, signIn, type TestContext, uniqueEmail } from './helpers';

let ctx: TestContext;
let admin: string;
const PASSWORD = 'Counter-Ledger-Board-2026';
const mobile = () => `9${randomInt(100_000_000, 999_999_999)}`;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = (await signIn(ctx, 'superadmin@pay2all.local')).accessToken!;
});

afterAll(async () => {
  await ctx.app.close();
});

/** Sign up an agent through the public flow; `native` uses the mobile-app session delivery. */
async function signUpAgent(opts: { native?: boolean } = {}) {
  const email = uniqueEmail('agent');
  const ip = randomIp();
  const started = await ctx.http().post('/v1/signup').set('X-Forwarded-For', ip).send({ name: 'Ravi Kumar', business_name: 'Ravi Digital Seva', email, mobile: mobile(), password: PASSWORD, accept_terms: true, account_type: 'AGENT' });
  expect(started.status).toBe(200);
  const mail = (await queuedMail(ctx, email)).filter((m) => m.template === 'signup_otp').pop()!;
  const code = /code is (\d{6})/.exec(mail.text)![1]!;
  const req = ctx.http().post('/v1/signup/verify').set('X-Forwarded-For', ip);
  if (opts.native) req.set('X-Pay2All-Client', 'mobile');
  const res = await req.send({ signup_id: started.body.data.signup_id, code });
  expect(res.status).toBe(200);
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  return { res, email, token: res.body.data.access_token as string, agentId: user.memberships[0]!.organizationId, userId: user.id };
}

async function payLink(billingOwner: string, token: string) {
  const pay = await ctx.http().post(`/v1/public/checkout/${token}/pay`).send({ method: 'UPI', customer: { name: 'Ravi Kumar', email: 'ravi@example.com', mobile: '+919876543210' } });
  expect(pay.status).toBe(200);
  await ctx.http().post(`/v1/sandbox/payments/${pay.body.data.id}/complete`).set(bearer(billingOwner)).send({ outcome: 'SUCCESS' }).expect(200);
}

const api = {
  get: (token: string, path: string) => ctx.http().get(path).set(bearer(token)),
  post: (token: string, path: string, body?: object) => ctx.http().post(path).set(bearer(token)).send(body ?? {}),
};

describe('Agent sign-up and sessions', () => {
  it('creates an AGENT organization on the Free plan, signed in without two-factor', async () => {
    const a = await signUpAgent();
    expect(a.res.body.data.status).toBe('AUTHENTICATED');
    expect(extractRefreshCookie(a.res)).toBeTruthy();
    expect(a.res.body.data.refresh_token).toBeUndefined();

    const org = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: a.agentId } });
    expect(org.type).toBe('AGENT');
    const me = await api.get(a.token, '/v1/auth/me');
    expect(me.body.data.organization.type).toBe('AGENT');
    expect(me.body.data.permissions).toEqual(expect.arrayContaining(['agent.desk.write', 'agent.settings.manage', 'agent.billing.manage']));

    const profile = await api.get(a.token, '/v1/agent/profile');
    expect(profile.body.data).toMatchObject({ shop_name: 'Ravi Digital Seva', plan: { code: 'FREE', monthly_txn_limit: 100 }, usage: { transactions_this_month: 0, staff: 1 } });
    expect((await queuedMail(ctx, a.email)).some((m) => m.template === 'agent_signup_welcome')).toBe(true);
    // No merchant row: agents never enter KYB onboarding.
    expect(await ctx.prisma.merchant.findUnique({ where: { id: a.agentId } })).toBeNull();
  });

  it('gives native apps the refresh token in the body and rotates it there', async () => {
    const a = await signUpAgent({ native: true });
    const first = a.res.body.data.refresh_token as string;
    expect(first).toBeTruthy();
    expect(extractRefreshCookie(a.res)).toBeNull();

    const r1 = await ctx.http().post('/v1/auth/mobile/refresh').set('X-Pay2All-Client', 'mobile').send({ refresh_token: first });
    expect(r1.status).toBe(200);
    const second = r1.body.data.refresh_token as string;
    expect(second).not.toBe(first);
    expect((await api.get(r1.body.data.access_token, '/v1/agent/dashboard')).status).toBe(200);

    // Without the native header the body route is refused; an old token is reuse and fails.
    expect((await ctx.http().post('/v1/auth/mobile/refresh').send({ refresh_token: second })).status).toBe(403);
    expect((await ctx.http().post('/v1/auth/mobile/refresh').set('X-Pay2All-Client', 'mobile').send({ refresh_token: first })).status).toBe(401);

    const login = await ctx.http().post('/v1/auth/login').set('X-Pay2All-Client', 'mobile').set('X-Forwarded-For', randomIp()).send({ identifier: a.email, password: PASSWORD });
    expect(login.body.data.refresh_token).toBeTruthy();
    const out = await ctx.http().post('/v1/auth/mobile/logout').set('X-Pay2All-Client', 'mobile').send({ refresh_token: login.body.data.refresh_token });
    expect(out.body.data.logged_out).toBe(true);
    expect((await ctx.http().post('/v1/auth/mobile/refresh').set('X-Pay2All-Client', 'mobile').send({ refresh_token: login.body.data.refresh_token })).status).toBe(401);
  });
});

describe('Agent counter', () => {
  it('records a money transfer with customer and beneficiary, receipts and totals', async () => {
    const a = await signUpAgent();
    const custMobile = mobile();
    expect((await api.get(a.token, `/v1/agent/customers/lookup?mobile=${custMobile}`)).body.data.customer).toBeNull();

    const cust = await api.post(a.token, '/v1/agent/customers', { name: 'Sita Devi', mobile: custMobile, id_type: 'AADHAAR', id_number: '1234 5678 9012' });
    expect(cust.status).toBe(201);
    expect(cust.body.data.id_number_masked).toBe('XXXX9012');
    const dup = await api.post(a.token, '/v1/agent/customers', { name: 'Someone', mobile: custMobile });
    expect(dup.status).toBe(409);

    const ben = await api.post(a.token, `/v1/agent/customers/${cust.body.data.id}/beneficiaries`, { name: 'Mohan Lal', bank_name: 'State Bank of India', account_number: '123456789012', ifsc: 'sbin0001234' });
    expect(ben.status).toBe(201);
    expect(ben.body.data).toMatchObject({ account_number: '123456789012', account_masked: 'XXXX9012', ifsc: 'SBIN0001234' });
    expect((await api.post(a.token, `/v1/agent/customers/${cust.body.data.id}/beneficiaries`, { name: 'No account' })).status).toBe(400);

    // Encrypted at rest.
    const rawCust = await ctx.prisma.agentCustomer.findUniqueOrThrow({ where: { id: cust.body.data.id } });
    expect(rawCust.idNumberEnc).not.toContain('9012');
    const rawBen = await ctx.prisma.agentBeneficiary.findUniqueOrThrow({ where: { id: ben.body.data.id } });
    expect(rawBen.accountNumberEnc).not.toContain('123456789012');
    expect((await api.get(a.token, `/v1/agent/customers/${cust.body.data.id}/id-number`)).body.data.id_number).toBe('1234 5678 9012');

    const key = randomUUID().replace(/-/g, '');
    const body = { type: 'MONEY_TRANSFER', mode: 'CASH', amount: '5000.00', fee: '50.00', reference: 'RRN123456', customer_id: cust.body.data.id, beneficiary_id: ben.body.data.id };
    const t1 = await ctx.http().post('/v1/agent/transactions').set(bearer(a.token)).set('Idempotency-Key', key).send(body);
    expect(t1.status).toBe(201);
    expect(t1.body.data).toMatchObject({ receipt_no: 'R-000001', direction: 'IN', status: 'SUCCESS', amount: '5000.00', fee: '50.00', total: '5050.00', customer: { name: 'Sita Devi' }, beneficiary: { name: 'Mohan Lal', account_masked: 'XXXX9012' } });
    // The same key never records twice.
    const again = await ctx.http().post('/v1/agent/transactions').set(bearer(a.token)).set('Idempotency-Key', key).send(body);
    expect(again.body.data.id).toBe(t1.body.data.id);

    const t2 = await api.post(a.token, '/v1/agent/transactions', { type: 'CASH_WITHDRAWAL', mode: 'CASH', amount: '2000.00', fee: '20.00', customer_name: 'Walk-in', customer_mobile: mobile() });
    expect(t2.body.data).toMatchObject({ receipt_no: 'R-000002', direction: 'OUT', total: '1980.00' });
    expect((await api.post(a.token, '/v1/agent/transactions', { type: 'OTHER', amount: '10.00' })).status).toBe(400);
    expect((await api.post(a.token, '/v1/agent/transactions', { type: 'MONEY_TRANSFER', amount: '10.00', customer_id: cust.body.data.id })).status).toBe(400);
    expect((await api.post(a.token, '/v1/agent/transactions', { type: 'BILL_PAYMENT', amount: '10.00', occurred_at: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(400);

    const dash = await api.get(a.token, '/v1/agent/dashboard');
    expect(dash.body.data.today).toMatchObject({ money_in: '5000.00', money_out: '2000.00', fees: '70.00', net: '3070.00', count: 2 });

    // Status: SUCCESS → REFUNDED is allowed, then final.
    const refunded = await api.post(a.token, `/v1/agent/transactions/${t2.body.data.id}/status`, { status: 'REFUNDED', note: 'Customer returned cash' });
    expect(refunded.body.data.status).toBe('REFUNDED');
    expect((await api.post(a.token, `/v1/agent/transactions/${t2.body.data.id}/status`, { status: 'SUCCESS' })).status).toBe(409);
    expect((await api.get(a.token, '/v1/agent/dashboard')).body.data.today.money_out).toBe('0.00');

    // Receipt: Free plan shows the platform name, no branding; the public link hides internals.
    const receipt = await api.get(a.token, `/v1/agent/transactions/${t1.body.data.id}/receipt`);
    expect(receipt.body.data).toMatchObject({ branded: false, type_label: 'Money transfer', shop: { name: 'Ravi Digital Seva', logo_url: null } });
    expect(receipt.body.data.powered_by).toBeTruthy();
    const pub = await ctx.http().get(`/v1/public/agent-receipts/${t1.body.data.receipt_token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.transaction.receipt_token).toBeUndefined();
    expect(pub.body.data.transaction.created_by).toBeUndefined();
    expect((await ctx.http().get(`/v1/public/agent-receipts/${'x'.repeat(32)}`)).status).toBe(404);

    // SMS receipts need the Business plan.
    expect((await api.post(a.token, `/v1/agent/transactions/${t1.body.data.id}/send-receipt`, { channel: 'SMS' })).status).toBe(403);

    // Reports.
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const summary = await api.get(a.token, `/v1/agent/reports/summary?from=${today}&to=${today}`);
    expect(summary.body.data.totals).toMatchObject({ money_in: '5000.00', money_out: '0.00', fees: '50.00', count: 1 });
    expect(summary.body.data.by_status).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'REFUNDED', count: 1 })]));
    const csv = await api.get(a.token, `/v1/agent/reports/export?from=${today}&to=${today}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('R-000001');
    expect(csv.text).toContain('Sita Devi');

    const list = await api.get(a.token, '/v1/agent/transactions?search=Sita');
    expect(list.body.data).toHaveLength(1);
  });

  it('keeps agents apart and keeps merchants out', async () => {
    const a = await signUpAgent();
    const b = await signUpAgent();
    const cust = await api.post(a.token, '/v1/agent/customers', { name: 'Private Person', mobile: mobile() });
    const t = await api.post(a.token, '/v1/agent/transactions', { type: 'RECHARGE', amount: '199.00', customer_id: cust.body.data.id });
    expect((await api.get(b.token, `/v1/agent/customers/${cust.body.data.id}`)).status).toBe(404);
    expect((await api.get(b.token, `/v1/agent/transactions/${t.body.data.id}`)).status).toBe(404);
    expect((await api.get(b.token, `/v1/agent/transactions/${t.body.data.id}/receipt`)).status).toBe(404);
    expect((await api.post(b.token, '/v1/agent/transactions', { type: 'RECHARGE', amount: '1.00', customer_id: cust.body.data.id })).status).toBe(404);
    expect((await api.get(b.token, '/v1/agent/customers')).body.data).toHaveLength(0);

    const merchant = (await signIn(ctx, 'owner@sharma-electronics.local')).accessToken!;
    expect((await api.get(merchant, '/v1/agent/dashboard')).status).toBe(403);
    expect((await api.get(a.token, '/v1/admin/agents')).status).toBe(403);
    expect((await api.get(a.token, '/v1/payments')).status).toBe(403);
  });
});

describe('Agent plans', () => {
  it('stops recording at the monthly allowance', async () => {
    const a = await signUpAgent();
    const free = await ctx.prisma.agentPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    await ctx.prisma.agentPlan.update({ where: { code: 'FREE' }, data: { monthlyTxnLimit: 2 } });
    try {
      for (let i = 0; i < 2; i++) expect((await api.post(a.token, '/v1/agent/transactions', { type: 'RECHARGE', amount: '10.00' })).status).toBe(201);
      const over = await api.post(a.token, '/v1/agent/transactions', { type: 'RECHARGE', amount: '10.00' });
      expect(over.status).toBe(422);
      expect(over.body.error.code).toBe('LIMIT_EXCEEDED');
    } finally {
      await ctx.prisma.agentPlan.update({ where: { code: 'FREE' }, data: { monthlyTxnLimit: free.monthlyTxnLimit } });
    }
  });

  it('caps staff logins by plan; operators record but cannot manage', async () => {
    const a = await signUpAgent();
    const staff = { name: 'Counter One', email: uniqueEmail('op'), mobile: mobile(), password: 'Counter-Operator-Pass-77' };
    const blocked = await api.post(a.token, '/v1/agent/staff', staff);
    expect(blocked.status).toBe(422);

    const until = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const grant = await api.post(admin, `/v1/admin/agents/${a.agentId}/plan`, { plan_code: 'STARTER', expires_at: until });
    expect(grant.status).toBe(200);
    expect((await api.get(a.token, '/v1/agent/profile')).body.data.plan.code).toBe('STARTER');

    const created = await api.post(a.token, '/v1/agent/staff', staff);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ staff_limit: 3, active: 2 });

    const op = (await signIn(ctx, staff.email, staff.password)).accessToken!;
    const cust = await api.post(op, '/v1/agent/customers', { name: 'Op Customer', mobile: mobile() });
    expect(cust.status).toBe(201);
    const t = await api.post(op, '/v1/agent/transactions', { type: 'CASH_DEPOSIT', amount: '700.00', customer_id: cust.body.data.id });
    expect(t.body.data.created_by).toBe('Counter One');
    expect((await api.post(op, `/v1/agent/transactions/${t.body.data.id}/status`, { status: 'FAILED' })).status).toBe(403);
    expect((await api.get(op, '/v1/agent/staff')).status).toBe(403);
    expect((await api.post(op, '/v1/agent/billing/checkout', { plan_code: 'BUSINESS', period: 'MONTHLY' })).status).toBe(403);

    const opUser = created.body.data.members.find((m: { email: string }) => m.email === staff.email);
    const disabled = await api.post(a.token, `/v1/agent/staff/${opUser.user_id}/status`, { active: false });
    expect(disabled.body.data.active).toBe(1);
    expect((await api.get(op, '/v1/agent/dashboard')).status).toBe(401);
    expect((await api.post(a.token, `/v1/agent/staff/${a.userId}/status`, { active: false })).status).toBe(400);
  });

  it('sells a plan through a payment link on the billing merchant', async () => {
    const a = await signUpAgent();
    // No billing merchant set → no online payment.
    await ctx.prisma.agentProgramSettings.update({ where: { id: 'default' }, data: { billingMerchantId: null } });
    expect((await api.get(a.token, '/v1/agent/billing')).body.data.online_payment_available).toBe(false);
    expect((await api.post(a.token, '/v1/agent/billing/checkout', { plan_code: 'STARTER', period: 'MONTHLY' })).status).toBe(400);

    const billing = await createApprovedMerchant(ctx);
    const set = await ctx.http().put('/v1/admin/agent-settings').set(bearer(admin)).send({ billing_merchant_id: billing.id });
    expect(set.body.data).toMatchObject({ billing_merchant_id: billing.id, billing_ready: true });

    const order = await api.post(a.token, '/v1/agent/billing/checkout', { plan_code: 'STARTER', period: 'MONTHLY' });
    expect(order.status).toBe(201);
    expect(order.body.data).toMatchObject({ plan_code: 'STARTER', amount: '199.00', status: 'PENDING' });
    expect(order.body.data.checkout_url).toMatch(/\/checkout\/[A-Za-z0-9_-]{32}$/);
    // Asking again reuses the open order.
    expect((await api.post(a.token, '/v1/agent/billing/checkout', { plan_code: 'STARTER', period: 'MONTHLY' })).body.data.id).toBe(order.body.data.id);

    const row = await ctx.prisma.agentPlanOrder.findUniqueOrThrow({ where: { id: order.body.data.id } });
    const session = await ctx.prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.checkoutSessionId! } });
    expect(session).toMatchObject({ merchantId: billing.id, kind: 'LINK', amountMinor: 19900n });

    // The agent pays on the hosted checkout; the sandbox gateway completes the UPI payment.
    await payLink(billing.owner, session.token);
    const paid = await api.get(a.token, `/v1/agent/billing/orders/${order.body.data.id}`);
    expect(paid.body.data.status).toBe('PAID');
    const profile = (await api.get(a.token, '/v1/agent/profile')).body.data;
    expect(profile.plan.code).toBe('STARTER');
    const days = (new Date(profile.plan.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);

    // Renewing the same plan extends from the current end.
    const renew = await api.post(a.token, '/v1/agent/billing/checkout', { plan_code: 'STARTER', period: 'YEARLY' });
    const renewRow = await ctx.prisma.agentPlanOrder.findUniqueOrThrow({ where: { id: renew.body.data.id } });
    await payLink(billing.owner, (await ctx.prisma.checkoutSession.findUniqueOrThrow({ where: { id: renewRow.checkoutSessionId! } })).token);
    await api.get(a.token, `/v1/agent/billing/orders/${renew.body.data.id}`);
    const after = (await api.get(a.token, '/v1/agent/profile')).body.data;
    expect(new Date(after.plan.expires_at).getTime() - new Date(profile.plan.expires_at).getTime()).toBeGreaterThan(360 * 86_400_000);
  });

  it('lets platform admins edit plans and see agents', async () => {
    const a = await signUpAgent();
    const list = await api.get(admin, `/v1/admin/agents?search=${encodeURIComponent(a.email)}`);
    expect(list.body.data[0]).toMatchObject({ id: a.agentId, plan_code: 'FREE', status: 'ACTIVE' });
    const before = await ctx.prisma.agentPlan.findUniqueOrThrow({ where: { code: 'BUSINESS' } });
    try {
      const upd = await ctx.http().patch('/v1/admin/agent-plans/BUSINESS').set(bearer(admin)).send({ price_monthly: '599.00', monthly_txn_limit: null });
      expect(upd.body.data).toMatchObject({ price_monthly: '599.00', monthly_txn_limit: null });
      expect((await ctx.http().get('/v1/public/agent-plans')).body.data.find((p: { code: string }) => p.code === 'BUSINESS').price_monthly).toBe('599.00');
      expect((await ctx.http().patch('/v1/admin/agent-plans/FREE').set(bearer(admin)).send({ active: false })).status).toBe(400);
    } finally {
      await ctx.prisma.agentPlan.update({ where: { code: 'BUSINESS' }, data: { priceMonthlyMinor: before.priceMonthlyMinor, monthlyTxnLimit: before.monthlyTxnLimit } });
    }

    const suspended = await api.post(admin, `/v1/admin/agents/${a.agentId}/status`, { status: 'SUSPENDED', reason: 'Test' });
    expect(suspended.body.data.status).toBe('SUSPENDED');
    expect((await api.get(a.token, '/v1/agent/dashboard')).status).toBe(401);
  });
});
