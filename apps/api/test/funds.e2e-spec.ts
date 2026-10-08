import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectionLedgerCode } from '../src/modules/funds/funds.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let superAdmin: string;
let finance: string;
let support: string;
let bankId: string;
let upiId: string;
const reason = 'Funds e2e test';
const utr = () => `${Math.floor(1e11 + Math.random() * 9e11)}`;
const now = () => new Date().toISOString();
const balance = async (merchantId: string) => (await ctx.prisma.ledgerAccount.findUnique({ where: { code: Accounts.merchant(merchantId, 'AVAILABLE') } }))?.balanceMinor ?? 0n;

async function cleanup() {
  await ctx.prisma.fundRequest.deleteMany({ where: { collectionAccount: { label: { startsWith: 'E2E ' } } } });
  await ctx.prisma.collectionAccount.deleteMany({ where: { label: { startsWith: 'E2E ' } } });
}

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  superAdmin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id })).email)).accessToken;
  finance = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'FINANCE', organizationId: platform.id })).email)).accessToken;
  support = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPPORT', organizationId: platform.id })).email)).accessToken;
  await cleanup();
});

afterAll(async () => {
  // Ledger invariant: every journal balances.
  const unbalanced = await ctx.prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM (SELECT journal_id FROM ledger_entries GROUP BY journal_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END)) j`;
  expect(unbalanced[0]!.n).toBe(0n);
  await cleanup();
  await ctx.app.close();
});

describe('collection accounts', () => {
  it('super admins add bank and UPI accounts; the account number is encrypted and masked', async () => {
    const bank = await ctx.http().post('/v1/funds/accounts').set(bearer(superAdmin)).send({
      kind: 'BANK', label: 'E2E HDFC Collections', account_holder: 'Pay2All Services Pvt Ltd', account_number: '50200012345678', ifsc: 'hdfc0001234', bank_name: 'HDFC Bank', branch: 'Andheri East', account_type: 'CURRENT', min_amount: '100.00', max_amount: '500000.00', reason,
    });
    expect(bank.status).toBe(201);
    expect(bank.body.data).toMatchObject({ kind: 'BANK', ifsc: 'HDFC0001234', account_number_masked: 'XXXXXX5678' });
    expect(JSON.stringify(bank.body)).not.toContain('50200012345678');
    bankId = bank.body.data.id;
    const row = await ctx.prisma.collectionAccount.findUniqueOrThrow({ where: { id: bankId } });
    expect(row.accountNumberEncrypted).not.toContain('50200012345678');

    const upi = await ctx.http().post('/v1/funds/accounts').set(bearer(superAdmin)).send({ kind: 'UPI', label: 'E2E UPI', upi_id: 'pay2all.collect@hdfcbank', payee_name: 'Pay2All Services', reason });
    expect(upi.status).toBe(201);
    upiId = upi.body.data.id;

    expect((await ctx.http().post('/v1/funds/accounts').set(bearer(finance)).send({ kind: 'UPI', label: 'E2E x', upi_id: 'x@okaxis', payee_name: 'X', reason })).status).toBe(403);
    expect((await ctx.http().post('/v1/funds/accounts').set(bearer(superAdmin)).send({ kind: 'UPI', label: 'E2E bad', upi_id: 'not-a-vpa', payee_name: 'X', reason })).status).toBe(400);
    expect((await ctx.http().post('/v1/funds/accounts').set(bearer(superAdmin)).send({ kind: 'BANK', label: 'E2E bad', account_holder: 'X Y', account_number: '12', ifsc: 'HDFC0001234', bank_name: 'HDFC', reason })).status).toBe(400);
  });

  it('merchants see active accounts with the full number (to pay into); inactive ones disappear', async () => {
    const m = await createApprovedMerchant(ctx);
    const res = await ctx.http().get('/v1/funds/accounts').set(bearer(m.owner));
    const bank = res.body.data.find((a: { id: string }) => a.id === bankId);
    expect(bank).toMatchObject({ account_number: '50200012345678', ifsc: 'HDFC0001234' });
    await ctx.http().put(`/v1/funds/accounts/${upiId}`).set(bearer(superAdmin)).send({ kind: 'UPI', label: 'E2E UPI', upi_id: 'pay2all.collect@hdfcbank', payee_name: 'Pay2All Services', is_active: false, reason }).expect(200);
    expect((await ctx.http().get('/v1/funds/accounts').set(bearer(m.owner))).body.data.some((a: { id: string }) => a.id === upiId)).toBe(false);
    await ctx.http().put(`/v1/funds/accounts/${upiId}`).set(bearer(superAdmin)).send({ kind: 'UPI', label: 'E2E UPI', upi_id: 'pay2all.collect@hdfcbank', payee_name: 'Pay2All Services', is_active: true, reason }).expect(200);
  });
});

describe('fund requests', () => {
  it('pay, submit the UTR, approve → wallet credited by a balanced FUND_LOAD journal', async () => {
    const m = await createApprovedMerchant(ctx);
    const u = utr();
    const req = await ctx.http().post('/v1/funds/requests').set(bearer(m.owner)).send({ collection_account_id: upiId, amount: '2500.00', mode: 'UPI', utr: u, paid_at: now(), remarks: 'Top-up for payouts' });
    expect(req.status).toBe(201);
    expect(req.body.data).toMatchObject({ status: 'PENDING', amount: '2500.00', utr: u });
    const id = req.body.data.id as string;

    // Approvers are told; the same UTR can't be claimed twice.
    expect(await ctx.prisma.inboxNotification.count({ where: { resourceId: id, category: 'WALLET' } })).toBeGreaterThanOrEqual(1);
    const other = await createApprovedMerchant(ctx);
    const dup = await ctx.http().post('/v1/funds/requests').set(bearer(other.owner)).send({ collection_account_id: upiId, amount: '2500.00', mode: 'UPI', utr: u, paid_at: now() });
    expect(dup.status).toBe(409);

    expect((await ctx.http().post(`/v1/funds/requests/${id}/decision`).set(bearer(support)).send({ decision: 'APPROVE' })).status).toBe(403);
    const ok = await ctx.http().post(`/v1/funds/requests/${id}/decision`).set(bearer(finance)).send({ decision: 'APPROVE' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'APPROVED', credited_amount: '2500.00' });
    expect(await balance(m.id)).toBe(250_000n);

    const entries = await ctx.prisma.ledgerEntry.findMany({ where: { journalId: ok.body.data.journal_id }, include: { account: { select: { code: true } } } });
    expect(Object.fromEntries(entries.map((e) => [e.account.code, `${e.direction}:${e.amountMinor}`]))).toEqual({
      [collectionLedgerCode(upiId)]: 'DEBIT:250000',
      [Accounts.merchant(m.id, 'AVAILABLE')]: 'CREDIT:250000',
    });
    // Approving twice (or racing) never double-credits.
    expect((await ctx.http().post(`/v1/funds/requests/${id}/decision`).set(bearer(superAdmin)).send({ decision: 'APPROVE' })).status).toBe(409);
    expect(await balance(m.id)).toBe(250_000n);
    expect(await ctx.prisma.inboxNotification.count({ where: { organizationId: m.id, resourceId: id } })).toBeGreaterThanOrEqual(1);
  });

  it('concurrent approvals credit exactly once', async () => {
    const m = await createApprovedMerchant(ctx);
    const id = (await ctx.http().post('/v1/funds/requests').set(bearer(m.owner)).send({ collection_account_id: bankId, amount: '1000.00', mode: 'IMPS', utr: utr(), paid_at: now() })).body.data.id as string;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => ctx.http().post(`/v1/funds/requests/${id}/decision`).set(bearer(i % 2 ? finance : superAdmin)).send({ decision: 'APPROVE' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await balance(m.id)).toBe(100_000n);
    expect(await ctx.prisma.ledgerJournal.count({ where: { idempotencyKey: `fund_request:${id}:load` } })).toBe(1);
  });

  it('approver corrects the amount (up or down) only with a note; reject needs a reason', async () => {
    const m = await createApprovedMerchant(ctx);
    const id = (await ctx.http().post('/v1/funds/requests').set(bearer(m.owner)).send({ collection_account_id: bankId, amount: '1000.00', mode: 'NEFT', utr: `N${utr()}`, paid_at: now() })).body.data.id as string;
    expect((await ctx.http().post(`/v1/funds/requests/${id}/decision`).set(bearer(finance)).send({ decision: 'APPROVE', credited_amount: '900.00' })).status).toBe(400);
    const less = await ctx.http().post(`/v1/funds/requests/${id}/decision`).set(bearer(finance)).send({ decision: 'APPROVE', credited_amount: '900.00', note: 'Bank statement shows ₹900' });
    expect(less.body.data).toMatchObject({ status: 'APPROVED', amount: '1000.00', credited_amount: '900.00' });
    expect(await balance(m.id)).toBe(90_000n);

    // The merchant typed less than it paid; the UTR can't be resubmitted, so the approver credits more.
    const id2 = (await ctx.http().post('/v1/funds/requests').set(bearer(m.owner)).send({ collection_account_id: bankId, amount: '100.00', mode: 'IMPS', utr: utr(), paid_at: now() })).body.data.id as string;
    const more = await ctx.http().post(`/v1/funds/requests/${id2}/decision`).set(bearer(finance)).send({ decision: 'APPROVE', credited_amount: '1000.00', note: 'Statement shows ₹1,000; merchant typed ₹100' });
    expect(more.body.data.credited_amount).toBe('1000.00');
    expect(await balance(m.id)).toBe(190_000n);

    const r3 = (await ctx.http().post('/v1/funds/requests').set(bearer(m.owner)).send({ collection_account_id: bankId, amount: '700.00', mode: 'IMPS', utr: utr(), paid_at: now() })).body.data.id as string;
    expect((await ctx.http().post(`/v1/funds/requests/${r3}/decision`).set(bearer(finance)).send({ decision: 'REJECT', note: '' })).status).toBe(400);
    const rej = await ctx.http().post(`/v1/funds/requests/${r3}/decision`).set(bearer(finance)).send({ decision: 'REJECT', note: 'No such credit on the statement' });
    expect(rej.body.data.status).toBe('REJECTED');
    expect(await balance(m.id)).toBe(190_000n);
  });

  it('a UTR is accepted once, for ever: after approval, rejection or cancellation, by anyone, in any format', async () => {
    const a = await createApprovedMerchant(ctx);
    const b = await createApprovedMerchant(ctx);
    const send = (token: string, u: string) => ctx.http().post('/v1/funds/requests').set(bearer(token)).send({ collection_account_id: bankId, amount: '500.00', mode: 'IMPS', utr: u, paid_at: now() });

    const rejectedUtr = `HDFC${utr()}`;
    const r = (await send(a.owner, rejectedUtr)).body.data.id as string;
    await ctx.http().post(`/v1/funds/requests/${r}/decision`).set(bearer(finance)).send({ decision: 'REJECT', note: 'Not on the statement' }).expect(200);
    const again = await send(a.owner, rejectedUtr);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already been submitted on .* \(rejected\)\. Each UTR can be used only once/);
    // Another merchant learns nothing about whose claim it was.
    const other = await send(b.owner, rejectedUtr);
    expect(other.status).toBe(409);
    expect(other.body.error.message).not.toMatch(/rejected|approved|pending/);

    const cancelledUtr = utr();
    const c = (await send(a.owner, cancelledUtr)).body.data.id as string;
    await ctx.http().post(`/v1/funds/requests/${c}/cancel`).set(bearer(a.owner)).expect(200);
    expect((await send(a.owner, cancelledUtr)).status).toBe(409);

    // Spaces, dashes and case don't make a new UTR.
    const fmt = `abcd${utr()}`;
    expect((await send(a.owner, fmt)).status).toBe(201);
    expect((await send(b.owner, ` ${fmt.slice(0, 4)}-${fmt.slice(4, 9)} ${fmt.slice(9).toUpperCase()} `)).status).toBe(409);
  });

  it('the same UTR submitted many times at once creates one request (no double credit)', async () => {
    const merchants = await Promise.all([createApprovedMerchant(ctx), createApprovedMerchant(ctx)]);
    const u = utr();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ctx.http().post('/v1/funds/requests').set(bearer(merchants[i % 2]!.owner)).send({ collection_account_id: bankId, amount: '800.00', mode: 'IMPS', utr: u, paid_at: now() })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await ctx.prisma.fundRequest.count({ where: { utr: u } })).toBe(1);
  });

  it('validates the claim: account limits, UPI mode, dates, JSON numbers, merchant status', async () => {
    const m = await createApprovedMerchant(ctx);
    const send = (body: Record<string, unknown>) => ctx.http().post('/v1/funds/requests').set(bearer(m.owner)).send({ collection_account_id: bankId, amount: '1000.00', mode: 'IMPS', utr: utr(), paid_at: now(), ...body });
    expect((await send({ amount: '50.00' })).body.error.message).toMatch(/minimum/);
    expect((await send({ amount: '600000.00' })).body.error.message).toMatch(/maximum/);
    expect((await send({ collection_account_id: upiId, mode: 'NEFT' })).body.error.message).toMatch(/UPI/);
    expect((await send({ paid_at: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(400);
    expect((await send({ paid_at: new Date(Date.now() - 40 * 86_400_000).toISOString() })).status).toBe(400);
    expect((await send({ amount: 1000 })).status).toBe(400);
    expect((await send({ utr: 'ab!' })).status).toBe(400);
    expect((await send({ merchant_id: 'org_01ARZ3NDEKTSV4RRFFQ69G5FAV' })).status).toBe(400); // tenant never from the body

    await ctx.prisma.merchant.update({ where: { id: m.id }, data: { status: 'SUSPENDED' } });
    expect((await send({})).status).toBe(403);
  });

  it('merchants see only their own requests; can cancel while pending; attach a screenshot', async () => {
    const a = await createApprovedMerchant(ctx);
    const b = await createApprovedMerchant(ctx);
    const id = (await ctx.http().post('/v1/funds/requests').set(bearer(a.owner)).send({ collection_account_id: bankId, amount: '1000.00', mode: 'RTGS', utr: `R${utr()}`, paid_at: now() })).body.data.id as string;
    expect((await ctx.http().get(`/v1/funds/requests/${id}`).set(bearer(b.owner))).status).toBe(404);
    expect((await ctx.http().get('/v1/funds/requests').set(bearer(b.owner))).body.data).toHaveLength(0);
    expect((await ctx.http().post(`/v1/funds/requests/${id}/cancel`).set(bearer(b.owner))).status).toBe(404);

    const png = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(400, 16);
    png.writeUInt32BE(800, 20);
    const up = await ctx.http().post(`/v1/funds/requests/${id}/proof`).set(bearer(a.owner)).attach('file', png, 'payment.png');
    expect(up.status).toBe(201);
    expect(up.body.data.has_proof).toBe(true);
    expect((await ctx.http().post(`/v1/funds/requests/${id}/proof`).set(bearer(a.owner)).attach('file', Buffer.from('MZ not an image at all here'), 'x.png')).status).toBe(400);
    const proof = await ctx.http().get(`/v1/funds/requests/${id}/proof`).set(bearer(finance)).buffer(true);
    expect(proof.status).toBe(200);
    expect(proof.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(proof.body as Buffer, png)).toBe(0);

    expect((await ctx.http().post(`/v1/funds/requests/${id}/cancel`).set(bearer(a.owner))).body.data.status).toBe('CANCELLED');
    expect((await ctx.http().post(`/v1/funds/requests/${id}/decision`).set(bearer(finance)).send({ decision: 'APPROVE' })).status).toBe(409);
  });

  it('accounts with requests can only be switched off, not removed', async () => {
    expect((await ctx.http().post(`/v1/funds/accounts/${bankId}/remove`).set(bearer(superAdmin)).send({ reason })).status).toBe(409);
    const summary = await ctx.http().get('/v1/funds/summary').set(bearer(finance));
    expect(summary.body.data.pending_count).toBeGreaterThanOrEqual(1);
  });
});
