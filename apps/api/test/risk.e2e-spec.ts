import { randomUUID } from 'node:crypto';
import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { RiskSweepService } from '../src/modules/risk/risk-sweep.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string; // ADMIN: risk.manage
let compliance: string; // COMPLIANCE: risk.review
let ops: string; // OPERATIONS: payout.review (unknown-outcome reviews)
const created: string[] = [];

const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const orderId = () => `rk_${randomUUID().slice(0, 12)}`;
let acct = 0;
const accountNo = () => `6020${String(Date.now()).slice(-7)}${String(++acct).padStart(3, '0')}1`;

async function rule(body: Record<string, unknown>) {
  const res = await ctx.http().post('/v1/risk/rules').set(bearer(admin)).send({ code: `T_${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Test rule', mode: 'ENFORCE', ...body });
  expect(res.status).toBe(201);
  created.push(res.body.data.rule_id);
  return res.body.data as { rule_id: string; code: string; version: number };
}
const disable = (id: string) => ctx.http().patch(`/v1/risk/rules/${id}`).set(bearer(admin)).send({ enabled: false, reason: 'test finished' });
const pay = (token: string, amount: string, idem = key(), order = orderId()) =>
  ctx.http().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', idem).send({ merchant_order_id: order, amount, method: 'UPI' });
const payout = (token: string, amount: string) =>
  ctx
    .http()
    .post('/v1/payouts')
    .set(bearer(token))
    .set('Idempotency-Key', key())
    .send({ merchant_order_id: orderId(), amount, mode: 'IMPS', purpose: 'VENDOR_PAYMENT', beneficiary: { name: 'Ravi Menon', account_number: accountNo(), ifsc: 'HDFC0001234' } });
const resolve = (eventId: string, decision: 'CLEAR' | 'CONFIRM') => ctx.http().post(`/v1/risk/events/${eventId}/resolve`).set(bearer(compliance)).send({ decision, note: `reviewed: ${decision.toLowerCase()}` });
const events = (ruleId: string) => ctx.prisma.riskEvent.findMany({ where: { ruleId }, orderBy: { createdAt: 'asc' }, include: { actions: true } });
const balance = async (merchantId: string, bucket: 'AVAILABLE' | 'RESERVED') => (await ctx.prisma.ledgerAccount.findUnique({ where: { code: Accounts.merchant(merchantId, bucket) } }))?.balanceMinor ?? 0n;

async function fund(merchantId: string, minor: bigint) {
  const ledger = ctx.app.get(LedgerService);
  await ledger.run((tx) =>
    ledger.post(tx, {
      type: 'ADJUSTMENT_CREDIT',
      idempotencyKey: `test-fund:${randomUUID()}`,
      source: { type: 'ADJUSTMENT', id: `adj_${randomUUID()}` },
      description: 'Test funding',
      lines: [
        { accountCode: Accounts.ADJUSTMENT_SUSPENSE, direction: 'DEBIT', amountMinor: minor, currency: 'INR' },
        { accountCode: Accounts.merchant(merchantId, 'AVAILABLE'), direction: 'CREDIT', amountMinor: minor, currency: 'INR' },
      ],
    }),
  );
}

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
  compliance = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'COMPLIANCE', organizationId: platform.id })).email)).accessToken;
  ops = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'OPERATIONS', organizationId: platform.id })).email)).accessToken;
});

afterEach(async () => {
  // Rules apply platform-wide: never leave an enforcing test rule on for the next test or file.
  for (const id of created.splice(0)) await disable(id);
});

afterAll(async () => {
  await ctx.app.close();
});

describe('rule configuration', () => {
  it('validates type/service/action/params and is platform-only', async () => {
    const bad = async (body: Record<string, unknown>) => (await ctx.http().post('/v1/risk/rules').set(bearer(admin)).send({ code: 'T_BAD_RULE', name: 'Bad', ...body })).status;
    expect(await bad({ type: 'VOLUME_SPIKE', service: 'PAYIN', action: 'BLOCK', params: { multiplier: 5, baseline_days: 7, min_amount: '1000.00' } })).toBe(400); // BLOCK is inline-only
    expect(await bad({ type: 'BENEFICIARY_FAN_IN', service: 'PAYIN', action: 'BLOCK', params: { window_seconds: 60, max_count: 3 } })).toBe(400); // payouts only
    expect(await bad({ type: 'VELOCITY', service: 'PAYIN', action: 'DISABLE_PAYOUT', params: { window_seconds: 60, max_count: 3 } })).toBe(400);
    expect(await bad({ type: 'VELOCITY', service: 'PAYIN', action: 'BLOCK', params: { window_seconds: 60, max_count: 3.5 } })).toBe(400); // no floats
    expect(await bad({ type: 'AMOUNT_ANOMALY', service: 'PAYIN', action: 'BLOCK', params: { multiplier: 5, lookback_days: 7, min_sample: 10, min_amount: 100 } })).toBe(400); // money as string

    const m = await createApprovedMerchant(ctx);
    expect((await ctx.http().get('/v1/risk/rules').set(bearer(m.owner))).status).toBe(403);
    expect((await ctx.http().get('/v1/risk/events').set(bearer(m.owner))).status).toBe(403);
  });

  it('versions every edit, requires a reason, and audits old/new', async () => {
    const r = await rule({ type: 'VELOCITY', service: 'PAYIN', action: 'BLOCK', params: { window_seconds: 60, max_count: 1000 }, mode: 'MONITOR' });
    expect((await ctx.http().patch(`/v1/risk/rules/${r.rule_id}`).set(bearer(admin)).send({ params: { window_seconds: 60, max_count: 500 } })).status).toBe(400);
    const res = await ctx.http().patch(`/v1/risk/rules/${r.rule_id}`).set(bearer(admin)).send({ params: { window_seconds: 60, max_count: 500 }, reason: 'tighten after review' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ version: 2, params: { max_count: 500 } });
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'risk.rule.updated', resourceId: r.rule_id } });
    expect(audit?.oldValue).toMatchObject({ version: 1, params: { max_count: 1000 } });
    expect(audit?.newValue).toMatchObject({ version: 2, params: { max_count: 500 } });
  });
});

describe('inline payin checks', () => {
  it('BLOCK: velocity over the limit is declined with RISK_BLOCKED, replayed, and recorded with evidence', async () => {
    const m = await createApprovedMerchant(ctx);
    const other = await createApprovedMerchant(ctx);
    const r = await rule({ type: 'VELOCITY', service: 'PAYIN', action: 'BLOCK', params: { window_seconds: 60, max_count: 2 } });
    expect((await pay(m.owner, '100.00')).status).toBe(201);
    expect((await pay(m.owner, '100.00')).status).toBe(201);
    const idem = key();
    const order = orderId();
    const blocked = await pay(m.owner, '100.00', idem, order);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('RISK_BLOCKED');
    expect(blocked.body.error.message).not.toContain(r.code); // merchants are not told which rule fired
    const replay = await pay(m.owner, '100.00', idem, order); // same key and body
    expect(replay.status).toBe(403);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await pay(other.owner, '100.00')).status).toBe(201); // per-merchant window

    const evs = await events(r.rule_id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ merchantId: m.id, subjectType: 'PAYMENT', action: 'BLOCK', mode: 'ENFORCE', enforced: true, status: 'RECORDED', ruleVersion: 1 });
    expect(evs[0]!.evidence).toMatchObject({ observed_count: 3, max_count: 2, window_seconds: 60, rule_params: { max_count: 2 } });
    expect(await ctx.prisma.payment.count({ where: { id: evs[0]!.subjectId } })).toBe(0);
    expect(await ctx.prisma.payment.count({ where: { merchantId: m.id } })).toBe(2);
  });

  it('MONITOR: records what would have happened and lets the payment through', async () => {
    const m = await createApprovedMerchant(ctx);
    const r = await rule({ type: 'VELOCITY', service: 'PAYIN', action: 'BLOCK', mode: 'MONITOR', params: { window_seconds: 60, max_count: 1 } });
    expect((await pay(m.owner, '100.00')).status).toBe(201);
    const second = await pay(m.owner, '100.00');
    expect(second.status).toBe(201);
    const evs = await events(r.rule_id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ enforced: false, status: 'RECORDED', subjectId: second.body.data.payment_id });
  });

  it('DISABLE_PAYIN switches the service off, blocks this payment, and clearing the review restores it', async () => {
    const m = await createApprovedMerchant(ctx);
    const r = await rule({ type: 'NEW_MERCHANT_VOLUME', service: 'PAYIN', action: 'DISABLE_PAYIN', params: { new_merchant_days: 30, max_daily_amount: '100.00' } });
    const res = await pay(m.owner, '500.00');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RISK_BLOCKED');
    expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: m.id } })).payinEnabled).toBe(false);
    expect((await pay(m.owner, '50.00')).body.error.code).toBe('PAYIN_DISABLED');

    const [ev] = await events(r.rule_id);
    expect(ev).toMatchObject({ status: 'OPEN', enforced: true });
    expect(ev!.actions).toEqual([expect.objectContaining({ type: 'DISABLE_PAYIN', previousValue: true, active: true })]);
    expect(ev!.evidence).toMatchObject({ projected_volume: '500.00', max_daily_amount: '100.00' });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'risk.service_disabled', resourceId: m.id } })).toBe(1);

    const cleared = await resolve(ev!.id, 'CLEAR');
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ status: 'CLEARED', review_note: 'reviewed: clear', actions: [expect.objectContaining({ active: false })] });
    expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: m.id } })).payinEnabled).toBe(true);
    expect((await resolve(ev!.id, 'CLEAR')).status).toBe(409); // already resolved
  });

  it('HOLD_SETTLEMENT stacks: the hold stays until the last event holding it is cleared', async () => {
    const m = await createApprovedMerchant(ctx);
    const r = await rule({ type: 'NEW_MERCHANT_VOLUME', service: 'PAYIN', action: 'HOLD_SETTLEMENT', params: { new_merchant_days: 30, max_daily_amount: '100.00' } });
    expect((await pay(m.owner, '200.00')).status).toBe(201); // holds proceed
    expect((await pay(m.owner, '200.00')).status).toBe(201);
    const [e1, e2] = await events(r.rule_id);
    const holds = () => ctx.prisma.settlementHold.findMany({ where: { merchantId: m.id, releasedAt: null } });
    expect(await holds()).toHaveLength(1);
    expect(e1!.actions[0]!.holdId).toBe((await holds())[0]!.id);
    expect(e2!.actions[0]!.holdId).toBeNull();

    await resolve(e1!.id, 'CLEAR');
    expect(await holds()).toHaveLength(1); // e2 still holds it
    await resolve(e2!.id, 'CLEAR');
    expect(await holds()).toHaveLength(0);
  });
});

describe('inline payout checks', () => {
  it('MANUAL_REVIEW holds the payout with funds reserved; CLEAR queues it; CONFIRM rejects and releases', async () => {
    const m = await createApprovedMerchant(ctx);
    await fund(m.id, 2_000_000n);
    const r = await rule({ type: 'NEW_MERCHANT_VOLUME', service: 'PAYOUT', action: 'MANUAL_REVIEW', params: { new_merchant_days: 30, max_daily_amount: '1000.00' } });

    const held = await payout(m.owner, '5000.00');
    expect(held.status).toBe(202);
    expect(held.body.data).toMatchObject({ status: 'MANUAL_REVIEW', review_kind: 'RISK', total_debit: '5005.90' });
    expect(await balance(m.id, 'RESERVED')).toBe(500_590n);

    // The unknown-outcome path can never "settle" a payout that was never sent.
    const wrongPath = await ctx.http().post(`/v1/payouts/${held.body.data.payout_id}/review/resolve`).set(bearer(ops)).send({ outcome: 'SUCCESS', utr: 'UTR12345678', reason: 'bank confirmed transfer' });
    expect(wrongPath.status).toBe(409);
    expect(await ctx.prisma.payoutAttempt.count({ where: { payoutId: held.body.data.payout_id } })).toBe(0);

    const [ev] = await events(r.rule_id);
    expect(ev).toMatchObject({ status: 'OPEN', subjectType: 'PAYOUT', subjectId: held.body.data.payout_id });
    const merchantView = await ctx.http().get('/v1/risk/events').set(bearer(m.owner));
    expect(merchantView.status).toBe(403);
    expect((await resolve(ev!.id, 'CLEAR')).body.data.subject).toMatchObject({ status: 'QUEUED', held_by_risk: false });
    expect((await ctx.prisma.payout.findUniqueOrThrow({ where: { id: held.body.data.payout_id } })).status).toBe('QUEUED');

    const second = await payout(m.owner, '2000.00');
    expect(second.body.data.status).toBe('MANUAL_REVIEW');
    const [, ev2] = await events(r.rule_id);
    const confirmed = await resolve(ev2!.id, 'CONFIRM');
    expect(confirmed.body.data).toMatchObject({ status: 'CONFIRMED', subject: { status: 'REJECTED' } });
    const p2 = await ctx.prisma.payout.findUniqueOrThrow({ where: { id: second.body.data.payout_id } });
    expect(p2).toMatchObject({ status: 'REJECTED', failureCode: 'RISK_DECLINED' });
    expect(p2.releaseJournalId).not.toBeNull();
    // Only the first (queued) payout is still reserved.
    expect(await balance(m.id, 'RESERVED')).toBe(500_590n);
    expect(await balance(m.id, 'AVAILABLE')).toBe(2_000_000n - 500_590n);
  });

  it('BLOCK on beneficiary fan-in counts payouts to the same account across merchants', async () => {
    const a = await createApprovedMerchant(ctx);
    const b = await createApprovedMerchant(ctx);
    await fund(a.id, 1_000_000n);
    await fund(b.id, 1_000_000n);
    const r = await rule({ type: 'BENEFICIARY_FAN_IN', service: 'PAYOUT', action: 'BLOCK', params: { window_seconds: 3600, max_count: 2 } });
    const account = accountNo();
    const to = (token: string) =>
      ctx
        .http()
        .post('/v1/payouts')
        .set(bearer(token))
        .set('Idempotency-Key', key())
        .send({ merchant_order_id: orderId(), amount: '100.00', mode: 'IMPS', purpose: 'VENDOR_PAYMENT', beneficiary: { name: 'Ravi Menon', account_number: account, ifsc: 'HDFC0001234' } });
    expect((await to(a.owner)).status).toBe(202);
    expect((await to(b.owner)).status).toBe(202);
    const third = await to(a.owner);
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe('RISK_BLOCKED');
    const [ev] = await events(r.rule_id);
    expect(ev!.evidence).toMatchObject({ observed_count: 3, destination: 'BANK_ACCOUNT' });
    expect(JSON.stringify(ev!.evidence)).not.toContain(account); // never the account number
  });
});

describe('background sweep', () => {
  it('raises one deduplicated review per merchant and window for a failure burst', async () => {
    const m = await createApprovedMerchant(ctx);
    const r = await rule({ type: 'FAILED_ATTEMPTS', service: 'PAYIN', action: 'MANUAL_REVIEW', params: { window_minutes: 15, min_failed: 3, failure_rate_percent: 50 } });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await pay(m.owner, '100.00')).body.data.payment_id);
    // Fixture: three of four failed at the provider (no money moved for failed payins).
    await ctx.prisma.payment.updateMany({ where: { id: { in: ids.slice(0, 3) } }, data: { status: 'FAILED' } });

    const sweep = ctx.app.get(RiskSweepService);
    await sweep.run();
    await sweep.run();
    const evs = (await events(r.rule_id)).filter((e) => e.merchantId === m.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ subjectType: 'MERCHANT', status: 'OPEN', action: 'MANUAL_REVIEW' });
    expect(evs[0]!.evidence).toMatchObject({ failed: 3, total: 4, failure_rate_percent: 75 });
    expect(evs[0]!.dedupeKey).toContain(`${r.rule_id}:v1:${m.id}:`);

    const list = await ctx.http().get(`/v1/risk/events?status=OPEN&merchant_id=${m.id}`).set(bearer(compliance));
    expect(list.status).toBe(200);
    expect(list.body.data.map((e: { event_id: string }) => e.event_id)).toContain(evs[0]!.id);
  });
});
