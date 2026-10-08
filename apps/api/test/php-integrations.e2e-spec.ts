import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createApprovedMerchant, createTestContext, type TestContext } from './helpers';

/**
 * The PHP SDK and the WooCommerce plugin, run by the real PHP CLI against this API over HTTP.
 * Skipped where PHP isn't installed.
 */
const php = (() => {
  try {
    execFileSync('php', ['-v'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const root = path.resolve(__dirname, '../../../integrations');
const WHSEC = `whsec_${randomUUID().replace(/-/g, '')}`;

let ctx: TestContext;
let base: string;
let owner: string;
let key: { public_key: string; secret: string };

// Async: the API under test runs in this process, so a blocking call would deadlock.
const run = async (script: string, args: string[]) => JSON.parse((await promisify(execFile)('php', [path.join(root, script), ...args], { encoding: 'utf8', timeout: 30_000 })).stdout.trim()) as Record<string, unknown>;
type Woo = { result?: { result: string; redirect: string }; order: { id: number; paid: boolean; txn: string; status: string; notes: string[]; meta: Record<string, unknown> }; log: { notices: [string, string][]; redirect: string | null; status: number | null }; refund?: unknown; stopped?: boolean };
const woo = async (step: string, state: Record<string, unknown> = {}) => (await run('woocommerce/tests/harness.php', [base, key.public_key, key.secret, WHSEC, step, JSON.stringify(state)])) as unknown as Woo;

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  const m = await createApprovedMerchant(ctx);
  owner = m.owner;
  const w = await ctx.http().post('/v1/checkout/websites').set(bearer(owner)).send({ url: 'https://shop.example.com' });
  await ctx.prisma.merchantWebsite.update({ where: { id: w.body.data.id as string }, data: { status: 'APPROVED', reviewedAt: new Date() } });
  const k = await ctx.http().post('/v1/developers/api-keys').set(bearer(owner)).send({ name: 'WooCommerce', permissions: ['payin.create', 'payin.read', 'payin.refund'] });
  expect(k.status).toBe(201);
  key = k.body.data as typeof key;
});

afterAll(async () => {
  await ctx.app.close();
});

async function customerPays(url: string) {
  const token = new URL(url).pathname.split('/').pop()!;
  const pay = await ctx.http().post(`/v1/public/checkout/${token}/pay`).send({ method: 'UPI', customer: { name: 'Asha Rao', email: 'asha@example.com', mobile: '9876543210' } });
  expect(pay.status).toBe(200);
  await ctx.http().post(`/v1/sandbox/payments/${pay.body.data.id}/complete`).set(bearer(owner)).send({ outcome: 'SUCCESS' }).expect(200);
  return pay.body.data.id as string;
}

describe.skipIf(!php)('PHP SDK', () => {
  it('signs requests, is idempotent, maps errors and verifies webhooks', async () => {
    const out = await run('php/tests/smoke.php', [base, key.public_key, key.secret, 'https://shop.example.com/thanks']);
    expect(out).toEqual({
      session_status: 'OPEN',
      session_amount: '1499.00',
      replay_same_id: true,
      retrieved: true,
      link_object: 'payment_link',
      not_found: ['NOT_FOUND', 404],
      // Uniform 401: the API never says which authentication check failed.
      bad_secret: ['UNAUTHORIZED', 401],
      webhook_ok: true,
      webhook_tampered: false,
      webhook_stale: false,
      webhook_rotated: true,
    });
  });

  it('ships the same client inside the WooCommerce and OpenCart plugins', async () => {
    const { readFileSync } = await import('node:fs');
    const sdk = readFileSync(path.join(root, 'php/src/Pay2All.php'), 'utf8');
    expect(readFileSync(path.join(root, 'woocommerce/pay2all-payments/lib/Pay2All.php'), 'utf8')).toBe(sdk);
    expect(readFileSync(path.join(root, 'opencart/pay2all/system/library/Pay2All.php'), 'utf8')).toBe(sdk);
  });
});

describe.skipIf(!php)('WooCommerce plugin', () => {
  it('order → hosted checkout → paid on return (confirmed with the API) → refund', async () => {
    const placed = await woo('pay', { total: '1499.00' });
    expect(placed.result?.result).toBe('success');
    expect(placed.result?.redirect).toMatch(/\/checkout\/[\w-]{32,}$/);
    const sessionId = placed.order.meta._pay2all_session_id as string;
    const session = await ctx.prisma.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session).toMatchObject({ merchantOrderId: `WC-${placed.order.id}-1`, amountMinor: 149_900n, customerMobile: '+919876543210' });
    expect(session.returnUrl).toBe(`https://shop.example.com/?wc-api=pay2all_return&order_id=${placed.order.id}&key=wc_order_key_${placed.order.id}`);

    // Back before paying: not paid, still on the thank-you page (pending).
    const early = await woo('return', { order_id: placed.order.id, meta: placed.order.meta });
    expect(early.order.paid).toBe(false);

    const paymentId = await customerPays(placed.result!.redirect);
    // A forged return (wrong order key) changes nothing.
    const forged = await woo('return', { order_id: placed.order.id, meta: placed.order.meta, key: 'nope' });
    expect(forged.order.paid).toBe(false);
    expect(forged.log.redirect).toBe('https://shop.example.com/cart');

    const back = await woo('return', { order_id: placed.order.id, meta: placed.order.meta });
    expect(back.order).toMatchObject({ paid: true, txn: paymentId, status: 'processing' });
    expect(back.log.redirect).toBe(`https://shop.example.com/checkout/order-received/${placed.order.id}`);
    expect(back.order.notes.join(' ')).toMatch(/Pay2All payment received \(UPI_QR, UTR \d+\)/);

    const refund = await woo('refund', { order_id: placed.order.id, txn: paymentId, paid: true, amount: '100.00' });
    expect(refund.refund).toBe(true);
    expect(await ctx.prisma.refund.count({ where: { paymentId } })).toBe(1);
  });

  it('marks the order paid from a signed webhook; rejects a bad signature', async () => {
    const placed = await woo('pay', { total: '250.00' });
    const paymentId = await customerPays(placed.result!.redirect);
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment.success', data: { payment_id: paymentId, merchant_order_id: `WC-${placed.order.id}-1#1`, status: 'SUCCESS' } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', WHSEC).update(`${t}.${body}`).digest('hex');

    const bad = await woo('webhook', { order_id: placed.order.id, total: '250.00', meta: placed.order.meta, body, signature: `t=${t},v1=${sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a')}` });
    expect(bad.log.status).toBe(400);
    expect(bad.order.paid).toBe(false);

    const ok = await woo('webhook', { order_id: placed.order.id, total: '250.00', meta: placed.order.meta, body, signature: `t=${t},v1=${sig}` });
    expect(ok.log.status).toBe(200);
    expect(ok.order).toMatchObject({ paid: true, txn: paymentId });
  });

  it('holds an order whose total differs from what was paid; sends cancelled checkouts back to pay again', async () => {
    const placed = await woo('pay', { total: '500.00' });
    await customerPays(placed.result!.redirect);
    const changed = await woo('return', { order_id: placed.order.id, meta: placed.order.meta, total: '650.00' });
    expect(changed.order).toMatchObject({ paid: false, status: 'on-hold' });

    const other = await woo('pay', { total: '75.00' });
    await ctx.http().post(`/v1/checkout/sessions/${other.order.meta._pay2all_session_id as string}/cancel`).set(bearer(owner)).expect(200);
    const back = await woo('return', { order_id: other.order.id, meta: other.order.meta });
    expect(back.log.redirect).toBe(`https://shop.example.com/checkout/order-pay/${other.order.id}`);
    expect(back.log.notices[0]?.[1]).toMatch(/not completed/);
    // The next attempt is a new reference (WC-<id>-2), so the shop can retry.
    const retry = await woo('pay', { order_id: other.order.id, total: '75.00', meta: other.order.meta });
    expect(await ctx.prisma.checkoutSession.count({ where: { merchantOrderId: `WC-${other.order.id}-2` } })).toBe(1);
    expect(retry.result?.result).toBe('success');
  });
});
