import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthRange } from '../src/modules/invoices/invoices.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let superAdmin: string;
let finance: string;
const MONTH = '2024-05'; // a past month no other suite writes to
const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const profile = { legal_name: 'Pay Services Pvt Ltd', gstin: '27AABCP1234C1Z0', pan: 'AABCP1234C', address: '12 MG Road, Pune, Maharashtra 411001', state_code: '27', sac: '997159', invoice_prefix: 'P2A', reason: 'Invoice e2e setup' };

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  superAdmin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id })).email)).accessToken;
  finance = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'FINANCE', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  await ctx.app.close();
});

/** Captured payments for a merchant, moved into MONTH (test-only backdating of success_at). */
async function feesInMonth(owner: string, amounts: string[]) {
  const ids: string[] = [];
  for (const amount of amounts) {
    const p = await ctx.http().post('/v1/payments').set(bearer(owner)).set('Idempotency-Key', key()).send({ merchant_order_id: `inv_${randomUUID().slice(0, 10)}`, amount, method: 'UPI', customer: { name: 'Asha', mobile: '9876500011' } });
    await ctx.http().post(`/v1/sandbox/payments/${p.body.data.payment_id}/complete`).set(bearer(owner)).send({ outcome: 'SUCCESS' }).expect(200);
    ids.push(p.body.data.payment_id as string);
  }
  const { start } = monthRange(MONTH);
  await ctx.prisma.payment.updateMany({ where: { id: { in: ids } }, data: { successAt: new Date(start.getTime() + 10 * 86_400_000) } });
  return ctx.prisma.payment.findMany({ where: { id: { in: ids } } });
}

describe('GST invoices', () => {
  it('needs a tax profile; only a completed month can be invoiced', async () => {
    expect((await ctx.http().post('/v1/admin/invoices/generate').set(bearer(finance)).send({ month: MONTH })).body.error.message).toMatch(/tax profile/);
    const bad = await ctx.http().put('/v1/admin/tax-profile').set(bearer(superAdmin)).send({ ...profile, state_code: '29' });
    expect(bad.status).toBe(400);
    const saved = await ctx.http().put('/v1/admin/tax-profile').set(bearer(superAdmin)).send(profile);
    expect(saved.body.data).toMatchObject({ gstin: '27AABCP1234C1Z0', state: 'Maharashtra', invoice_prefix: 'P2A' });
    expect((await ctx.http().put('/v1/admin/tax-profile').set(bearer(finance)).send(profile)).status).toBe(403);
    const future = new Date(Date.now() + 40 * 86_400_000);
    const month = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, '0')}`;
    expect((await ctx.http().post('/v1/admin/invoices/generate').set(bearer(finance)).send({ month })).body.error.message).toMatch(/after the month ends/);
  });

  it('issues one invoice per merchant: same state → CGST+SGST, other state → IGST; gapless numbers; idempotent; immutable', async () => {
    const local = await createApprovedMerchant(ctx);
    const remote = await createApprovedMerchant(ctx);
    await ctx.prisma.merchantProfile.update({ where: { merchantId: remote.id }, data: { legalName: 'Remote Traders LLP', gstin: '29AABCP1234C1Z0', registeredAddress: { line1: '5 Residency Rd', city: 'Bengaluru', state: 'Karnataka', pincode: '560025', country: 'IN' } } });
    const lp = await feesInMonth(local.owner, ['1000.00', '2500.00']);
    const rp = await feesInMonth(remote.owner, ['4000.00']);

    const run = await ctx.http().post('/v1/admin/invoices/generate').set(bearer(finance)).send({ month: MONTH });
    expect(run.status).toBe(200);
    expect(run.body.data.issued).toBeGreaterThanOrEqual(2);

    const mine = await ctx.http().get('/v1/invoices').set(bearer(local.owner));
    expect(mine.body.data).toHaveLength(1);
    const inv = mine.body.data[0];
    const fee = lp.reduce((n, p) => n + p.feeMinor, 0n);
    const tax = lp.reduce((n, p) => n + p.taxMinor, 0n);
    const rupees = (m: bigint) => `${m / 100n}.${String(m % 100n).padStart(2, '0')}`;
    expect(inv).toMatchObject({ inter_state: false, place_of_supply: { code: '27' }, taxable: rupees(fee), igst: '0.00', period: { label: 'May 2024' }, seller: { gstin: '27AABCP1234C1Z0' } });
    expect(BigInt(inv.cgst.replace('.', '')) + BigInt(inv.sgst.replace('.', ''))).toBe(tax);
    expect(inv.total).toBe(rupees(fee + tax));
    expect(inv.lines).toEqual([{ code: 'PAYIN_FEES', description: 'Payment collection (payin) service fees', sac: '997159', count: 2, taxable: rupees(fee), tax: rupees(tax) }]);
    expect(inv.number).toMatch(/^P2A\d{4}-\d{6}$/);
    expect(inv.number.length).toBeLessThanOrEqual(16);

    const theirs = (await ctx.http().get('/v1/invoices').set(bearer(remote.owner))).body.data[0];
    expect(theirs).toMatchObject({ inter_state: true, place_of_supply: { code: '29', state: 'Karnataka' }, cgst: '0.00', sgst: '0.00', igst: rupees(rp[0]!.taxMinor), buyer: { gstin: '29AABCP1234C1Z0', name: 'Remote Traders LLP' } });
    // Consecutive serials within the financial year.
    const serials = [inv.number, theirs.number].map((n: string) => Number(n.split('-')[1])).sort((a, b) => a - b);
    expect(serials[1]! - serials[0]!).toBe(1);

    // Re-running issues nothing new; issued invoices can't be edited; tenants are separate.
    expect((await ctx.http().post('/v1/admin/invoices/generate').set(bearer(finance)).send({ month: MONTH })).body.data.issued).toBe(0);
    await expect(ctx.prisma.invoice.update({ where: { id: inv.id as string }, data: { totalMinor: 1n } })).rejects.toThrow();
    expect((await ctx.http().get(`/v1/invoices/${theirs.id}`).set(bearer(local.owner))).status).toBe(404);
    expect((await ctx.http().get(`/v1/invoices?month=${MONTH}`).set(bearer(finance))).body.data.length).toBeGreaterThanOrEqual(2);
    expect(await ctx.prisma.inboxNotification.count({ where: { organizationId: local.id, resourceId: inv.id as string } })).toBe(1);
  });
});
