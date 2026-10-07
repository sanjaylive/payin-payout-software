import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { notifyInbox } from '@pay2all/database';
import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { PayoutTransitionsService } from '../src/modules/payouts/payout-transitions.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, SEED_PASSWORD, type TestContext } from './helpers';

let ctx: TestContext;
let base = '';
let compliance: string;
const key = () => `k_${randomUUID().replace(/-/g, '')}`;

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

/** Minimal SSE client: collects events until `until` matches or the timeout passes. */
function listen(token: string, until: (events: Array<{ event: string; data: unknown }>) => boolean, timeoutMs = 5000) {
  return new Promise<Array<{ event: string; data: unknown }>>((resolve, reject) => {
    const events: Array<{ event: string; data: unknown }> = [];
    const req = http.get(`${base}/v1/inbox/stream`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`stream ${res.statusCode}`));
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) as unknown });
          if (until(events)) {
            req.destroy();
            resolve(events);
          }
        }
      });
    });
    req.on('error', () => undefined);
    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  const platform = await orgBySlug(ctx, 'pay2all');
  compliance = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'COMPLIANCE', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  await ctx.app.close();
});

describe('bell notifications', () => {
  it('asks the checkers (not the maker) to approve a payout; read state is per user', async () => {
    const m = await createApprovedMerchant(ctx);
    await fund(m.id, 10_000_000n);
    const checker = await createUser(ctx, { roleKey: 'MERCHANT_FINANCE', organizationId: m.id });
    const checkerToken = (await loginWithMfaEnrollment(ctx, checker.email)).accessToken;
    // ₹20,000 is above the ₹10,000 auto-approval tier → APPROVAL_PENDING (and below the verified-beneficiary threshold).
    const res = await ctx.http().post('/v1/payouts').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: `in_${randomUUID().slice(0, 10)}`, amount: '20000.00', mode: 'IMPS', purpose: 'VENDOR_PAYMENT', beneficiary: { name: 'Ravi Menon', account_number: `7040${Date.now().toString().slice(-8)}1`, ifsc: 'HDFC0001234' } });
    expect(res.body.data.status).toBe('APPROVAL_PENDING');

    const inbox = await ctx.http().get('/v1/inbox').set(bearer(checkerToken));
    expect(inbox.body.data[0]).toMatchObject({ category: 'PAYOUT', severity: 'WARNING', title: 'Payout of ₹20,000.00 needs your approval', link: '/payout/approvals', read: false });
    expect((await ctx.http().get('/v1/inbox/unread-count').set(bearer(checkerToken))).body.data).toEqual({ unread: 1 });
    // The maker created it: not asked to approve it.
    expect((await ctx.http().get('/v1/inbox').set(bearer(m.owner))).body.data.filter((n: { title: string }) => n.title.includes('needs your approval'))).toHaveLength(0);

    const id = inbox.body.data[0].id as string;
    expect((await ctx.http().post(`/v1/inbox/${id}/read`).set(bearer(m.owner))).status).toBe(404); // not theirs
    expect((await ctx.http().post(`/v1/inbox/${id}/read`).set(bearer(checkerToken))).body.data).toEqual({ unread: 0 });
    expect((await ctx.http().get('/v1/inbox?unread=true').set(bearer(checkerToken))).body.data).toHaveLength(0);
  });

  it('notifies payout failures once, however often the outcome is replayed', async () => {
    const m = await createApprovedMerchant(ctx);
    await fund(m.id, 1_000_000n);
    const res = await ctx.http().post('/v1/payouts').set(bearer(m.owner)).set('Idempotency-Key', key()).send({ merchant_order_id: `in_${randomUUID().slice(0, 10)}`, amount: '500.00', mode: 'IMPS', purpose: 'VENDOR_PAYMENT', beneficiary: { name: 'Asha', account_number: `7050${Date.now().toString().slice(-8)}1`, ifsc: 'HDFC0001234' } });
    const id = res.body.data.payout_id as string;
    const t = ctx.app.get(PayoutTransitionsService);
    // Simulate: sent, then the bank rejects (twice — a duplicate callback).
    await t.ledgerRun(async (tx) => t.transition(tx, await t.lock(tx, id), 'PROCESSING', {}));
    await t.apply(id, { status: 'FAILED', failureReason: 'Account closed' }, 'CALLBACK');
    await t.apply(id, { status: 'FAILED', failureReason: 'Account closed' }, 'CALLBACK');
    const rows = await ctx.prisma.inboxNotification.findMany({ where: { resourceId: id, title: { contains: 'failed' } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'PAYOUT', severity: 'WARNING', body: expect.stringContaining('Account closed') });
  });

  it('a rolled-back transaction leaves no notification (and pushes nothing)', async () => {
    const m = await createApprovedMerchant(ctx);
    const owner = await ctx.prisma.userRole.findFirstOrThrow({ where: { organizationId: m.id } });
    const heard = listen(m.owner, (ev) => ev.some((e) => e.event === 'notification'), 1500);
    await new Promise((r) => setTimeout(r, 300));
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await notifyInbox(tx, { organizationId: m.id, audience: { userIds: [owner.userId] }, category: 'SYSTEM', title: 'Should never appear', body: 'rolled back' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await ctx.prisma.inboxNotification.count({ where: { title: 'Should never appear' } })).toBe(0);
    expect((await heard).filter((e) => e.event === 'notification')).toHaveLength(0);
  });

  it('pushes committed notifications in real time to that user only', async () => {
    const a = await createApprovedMerchant(ctx);
    const b = await createApprovedMerchant(ctx);
    const aUser = await ctx.prisma.userRole.findFirstOrThrow({ where: { organizationId: a.id } });
    const forA = listen(a.owner, (ev) => ev.some((e) => e.event === 'notification'));
    const forB = listen(b.owner, (ev) => ev.some((e) => e.event === 'notification'), 2500);
    await new Promise((r) => setTimeout(r, 400)); // both streams connected
    const started = Date.now();
    await notifyInbox(ctx.prisma, { organizationId: a.id, audience: { userIds: [aUser.userId] }, category: 'SETTLEMENT', severity: 'SUCCESS', title: 'Settlement of ₹1,000.00 sent', body: 'test', link: '/settlements' });
    const evA = await forA;
    expect(evA[0]).toMatchObject({ event: 'ready', data: { unread: expect.any(Number), live: true } });
    expect(evA.find((e) => e.event === 'notification')?.data).toMatchObject({ title: 'Settlement of ₹1,000.00 sent', category: 'SETTLEMENT', read: false });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await forB).filter((e) => e.event === 'notification')).toHaveLength(0);
  });

  it('tells the merchant when compliance needs more information', async () => {
    const platform = await orgBySlug(ctx, 'pay2all');
    const merchant = await ctx.prisma.organization.create({ data: { id: `org_${'0'.repeat(10)}${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase().replace(/[ILOU]/g, 'X')}`, slug: `inbox-${randomUUID().slice(0, 8)}`, name: 'Inbox Test Pvt Ltd', type: 'MERCHANT', parentId: platform.id } });
    await ctx.prisma.merchant.create({ data: { id: merchant.id, status: 'UNDER_REVIEW' } });
    await ctx.prisma.merchantProfile.create({ data: { merchantId: merchant.id, displayName: 'Inbox Test' } });
    await ctx.prisma.merchantKyc.create({ data: { merchantId: merchant.id } });
    const owner = await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: merchant.id });
    const res = await ctx.http().post(`/v1/merchants/${merchant.id}/review/request-information`).set(bearer(compliance)).send({ reason: 'Upload a clearer copy of the PAN card' });
    expect(res.status).toBe(200);
    const n = await ctx.prisma.inboxNotification.findFirstOrThrow({ where: { userId: owner.id } });
    expect(n).toMatchObject({ category: 'COMPLIANCE', severity: 'WARNING', title: 'More information needed for your application', body: 'Upload a clearer copy of the PAN card', link: '/compliance' });
  });

  it('warns a user about a sign-in from a new device / address (not on their first sign-in)', async () => {
    const m = await createApprovedMerchant(ctx);
    const u = await createUser(ctx, { roleKey: 'MERCHANT_VIEWER', organizationId: m.id });
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const signIn = (ip: string) => ctx.http().post('/v1/auth/login').set('X-Forwarded-For', ip).set('User-Agent', ua).send({ identifier: u.email, password: SEED_PASSWORD });
    await signIn('198.51.100.1');
    await signIn('198.51.100.1');
    expect(await ctx.prisma.inboxNotification.count({ where: { userId: u.id, category: 'SECURITY' } })).toBe(0);
    await signIn('203.0.113.99');
    const alert = await ctx.prisma.inboxNotification.findFirstOrThrow({ where: { userId: u.id, category: 'SECURITY' } });
    expect(alert.body).toContain('Chrome 141 on Windows from 203.0.113.99');
  });
});
