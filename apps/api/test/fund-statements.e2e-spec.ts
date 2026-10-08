import { Accounts } from '@pay2all/ledger/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let superAdmin: string;
let support: string;
let accountId: string;
const reason = 'Statement matching e2e';
const utr = () => `${Math.floor(1e11 + Math.random() * 9e11)}`;
const now = () => new Date().toISOString();
const balance = async (merchantId: string) => (await ctx.prisma.ledgerAccount.findUnique({ where: { code: Accounts.merchant(merchantId, 'AVAILABLE') } }))?.balanceMinor ?? 0n;

const statement = (rows: string[]) =>
  Buffer.from(
    [
      'Account Statement,STMT HDFC Collections',
      'Period,01/10/2026 to 08/10/2026',
      '',
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      ...rows,
    ].join('\n'),
  );
const credit = (ref: string, amount: string, narration = `UPI-MERCHANT-${ref}-TOPUP`) => `05/10/26,${narration},${ref},05/10/26,,"${amount}",0`;

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  superAdmin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id })).email)).accessToken;
  support = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPPORT', organizationId: platform.id })).email)).accessToken;
  const bank = await ctx.http().post('/v1/funds/accounts').set(bearer(superAdmin)).send({
    kind: 'BANK', label: 'STMT HDFC Collections', account_holder: 'Pay2All Services Pvt Ltd', account_number: '50200099887766', ifsc: 'HDFC0001234', bank_name: 'HDFC Bank', account_type: 'CURRENT', reason,
  });
  expect(bank.status).toBe(201);
  accountId = bank.body.data.id as string;
});

afterAll(async () => {
  const unbalanced = await ctx.prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM (SELECT journal_id FROM ledger_entries GROUP BY journal_id
      HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END)) j`;
  expect(unbalanced[0]!.n).toBe(0n);
  await ctx.app.close();
});

describe('bank statement matching', () => {
  it('approves exact matches, flags mismatches, keeps unclaimed credits, and never uses a credit twice', async () => {
    const m = await createApprovedMerchant(ctx);
    const ask = (u: string, amount: string) => ctx.http().post('/v1/funds/requests').set(bearer(m.owner)).send({ collection_account_id: accountId, amount, mode: 'NEFT', utr: u, paid_at: now() });
    const [u1, u2, u3, u4] = [utr(), utr(), utr(), utr()];
    const r1 = await ask(u1, '25000.00');
    const r2 = await ask(u2, '1000.00');
    const r3 = await ask(u3, '700.00');
    expect([r1.status, r2.status, r3.status]).toEqual([201, 201, 201]);
    await ctx.http().post(`/v1/funds/requests/${r3.body.data.id}/decision`).set(bearer(superAdmin)).send({ decision: 'REJECT', note: 'Not received yet' }).expect(200);
    const before = await balance(m.id);

    const file = statement([credit(u1, '25,000.00'), credit(u2, '1000.50'), credit(u3, '700.00'), credit(u4, '5,000.00'), '06/10/26,ATM WDL,,06/10/26,500.00,,0']);
    const imp = await ctx.http().post(`/v1/funds/statements/${accountId}`).set(bearer(superAdmin)).attach('file', file, { filename: 'hdfc-oct.csv', contentType: 'text/csv' });
    expect(imp.status).toBe(201);
    expect(imp.body.data.summary).toEqual({ credits: 4, matched: 1, mismatched: 1, unmatched: 1, already_decided: 1, duplicates: 0 });
    const byUtr = Object.fromEntries((imp.body.data.lines as { utr: string; status: string; fund_request: unknown }[]).map((l) => [l.utr, l]));
    expect(byUtr[u1]).toMatchObject({ status: 'MATCHED', amount: '25000.00', fund_request: { id: r1.body.data.id, status: 'APPROVED' } });
    expect(byUtr[u2]).toMatchObject({ status: 'AMOUNT_MISMATCH', amount: '1000.50', fund_request: { status: 'PENDING', amount: '1000.00' } });
    expect(byUtr[u3]).toMatchObject({ status: 'ALREADY_DECIDED', fund_request: { status: 'REJECTED' } });
    expect(byUtr[u4]).toMatchObject({ status: 'UNMATCHED', fund_request: null });

    // The matched request is credited through the normal FUND_LOAD journal.
    expect(await balance(m.id)).toBe(before + 2_500_000n);
    const approved = await ctx.prisma.fundRequest.findUniqueOrThrow({ where: { id: r1.body.data.id as string } });
    expect(approved).toMatchObject({ status: 'APPROVED', creditedAmountMinor: 2_500_000n });
    expect(approved.journalId).toBeTruthy();
    expect(await ctx.prisma.auditLog.count({ where: { action: 'funds.request.auto_approved', resourceId: approved.id } })).toBe(1);

    // The same file can't be imported twice; an overlapping statement doesn't reuse a credit.
    expect((await ctx.http().post(`/v1/funds/statements/${accountId}`).set(bearer(superAdmin)).attach('file', file, { filename: 'again.csv', contentType: 'text/csv' })).status).toBe(409);
    const overlap = await ctx.http().post(`/v1/funds/statements/${accountId}`).set(bearer(superAdmin)).attach('file', statement([credit(u1, '25,000.00'), credit(utr(), '10.00')]), { filename: 'overlap.csv', contentType: 'text/csv' });
    expect(overlap.body.data.summary).toMatchObject({ credits: 2, duplicates: 1, unmatched: 1, matched: 0 });
    expect(await balance(m.id)).toBe(before + 2_500_000n);

    // A merchant who submits the unclaimed credit's UTR and amount later is approved at once…
    const late = await ask(u4, '5000.00');
    expect(late.status).toBe(201);
    expect(late.body.data.status).toBe('APPROVED');
    expect(await balance(m.id)).toBe(before + 3_000_000n);
    // …but a different amount waits for a person.
    const other = await createApprovedMerchant(ctx);
    const u6 = utr();
    await ctx.http().post(`/v1/funds/statements/${accountId}`).set(bearer(superAdmin)).attach('file', statement([credit(u6, '300.00')]), { filename: 'small.csv', contentType: 'text/csv' }).expect(201);
    const wrong = await ctx.http().post('/v1/funds/requests').set(bearer(other.owner)).send({ collection_account_id: accountId, amount: '3000.00', mode: 'IMPS', utr: u6, paid_at: now() });
    expect(wrong.body.data.status).toBe('PENDING');
  });

  it('keeps statement lines as append-only evidence', async () => {
    const line = await ctx.prisma.statementLine.findFirstOrThrow({ where: { collectionAccountId: accountId } });
    await expect(ctx.prisma.statementLine.update({ where: { id: line.id }, data: { amountMinor: 1n } })).rejects.toThrow();
    await expect(ctx.prisma.statementLine.delete({ where: { id: line.id } })).rejects.toThrow();
  });

  it('only fund approvers import; bad files are explained', async () => {
    const csv = statement([credit(utr(), '10.00')]);
    expect((await ctx.http().post(`/v1/funds/statements/${accountId}`).set(bearer(support)).attach('file', csv, { filename: 's.csv', contentType: 'text/csv' })).status).toBe(403);
    const m = await createApprovedMerchant(ctx);
    expect((await ctx.http().post(`/v1/funds/statements/${accountId}`).set(bearer(m.owner)).attach('file', csv, { filename: 's.csv', contentType: 'text/csv' })).status).toBe(403);
    const bad = await ctx.http().post(`/v1/funds/statements/${accountId}`).set(bearer(superAdmin)).attach('file', Buffer.from('name,value\na,b'), { filename: 'x.csv', contentType: 'text/csv' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/header row/);
    const list = await ctx.http().get('/v1/funds/statements').set(bearer(superAdmin));
    expect(list.body.data.length).toBeGreaterThanOrEqual(3);
  });
});
