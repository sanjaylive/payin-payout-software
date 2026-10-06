import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeLlpProfile, llpPan, pdf, png } from './fixtures';
import { bearer, createTestContext, createUser, login, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let resellerId: string;
let resellerToken: string;
let complianceToken: string;
let compliance2Token: string;
let otherMerchantToken: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const reseller = await orgBySlug(ctx, 'acme-partners');
  const platform = await orgBySlug(ctx, 'pay2all');
  resellerId = reseller.id;
  resellerToken = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'RESELLER', organizationId: reseller.id })).email)).accessToken;
  complianceToken = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'COMPLIANCE', organizationId: platform.id })).email)).accessToken;
  compliance2Token = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'COMPLIANCE', organizationId: platform.id })).email)).accessToken;
  otherMerchantToken = (await login(ctx, 'owner@nimbus-software.local')).accessToken!;
});

afterAll(async () => {
  await ctx.app.close();
});

/** Reseller creates a merchant; returns its id and an owner token. */
async function newMerchant(name = 'Test Traders') {
  const res = await ctx.http().post('/v1/merchants').set(bearer(resellerToken)).send({ display_name: name, source: 'test' });
  expect(res.status).toBe(201);
  const id = res.body.data.id as string;
  const owner = await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: id });
  return { id, ownerToken: (await login(ctx, owner.email)).accessToken! };
}

function upload(token: string, merchantId: string, type: string, file = pdf(type), name = `${type}.pdf`, extra: Record<string, string> = {}) {
  let req = ctx.http().post(`/v1/merchants/${merchantId}/documents`).set(bearer(token)).field('type', type);
  for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
  return req.attach('file', file, name);
}

/** Fill a complete LLP application as the merchant owner. */
async function completeApplication(merchantId: string, token: string) {
  const pan = llpPan();
  expect((await ctx.http().patch(`/v1/merchants/${merchantId}/profile`).set(bearer(token)).send(completeLlpProfile(pan))).status).toBe(200);
  const person = await ctx.http().post(`/v1/merchants/${merchantId}/persons`).set(bearer(token)).send({
    full_name: 'Test Partner', pan: 'ABCPT1234Z', is_director: true, is_ubo: true, is_authorized_signatory: true, ownership_percent: '100.00',
  });
  expect(person.status).toBe(201);
  const bank = await ctx.http().post(`/v1/merchants/${merchantId}/bank-accounts`).set(bearer(token)).send({
    account_holder_name: 'Test Traders LLP', account_number: `5020${Math.floor(1e9 + Math.random() * 8e9)}`, ifsc: 'hdfc0000123',
  });
  expect(bank.status).toBe(201);
  for (const t of ['PAN', 'GST_CERTIFICATE', 'CIN_CERTIFICATE', 'ADDRESS_PROOF', 'CANCELLED_CHEQUE']) {
    expect((await upload(token, merchantId, t)).status).toBe(201);
  }
  expect((await upload(token, merchantId, 'DIRECTOR_KYC', pdf('kyc'), 'kyc.pdf', { person_id: person.body.data.id })).status).toBe(201);
  return { personId: person.body.data.id as string, bankId: bank.body.data.id as string };
}

describe('merchant onboarding', () => {
  it('reseller-created merchants start in DRAFT under the reseller with a creation record', async () => {
    const { id } = await newMerchant();
    const res = await ctx.http().get(`/v1/merchants/${id}`).set(bearer(resellerToken));
    expect(res.body.data).toMatchObject({ status: 'DRAFT', reseller: { id: resellerId }, can_submit: false });
    expect(res.body.data.reviews.map((r: { action: string }) => r.action)).toEqual(['CREATED']);
  });

  it('validates Indian identifiers (GSTIN checksum, PAN vs entity type)', async () => {
    const { id, ownerToken } = await newMerchant();
    const bad = await ctx.http().patch(`/v1/merchants/${id}/profile`).set(bearer(ownerToken)).send({ gstin: '27AAKFS1234K1ZX' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('gstin');
    // A float-like amount with 3 decimals is rejected, never rounded.
    const amount = await ctx.http().patch(`/v1/merchants/${id}/profile`).set(bearer(ownerToken)).send({ average_ticket_size: '100.555' });
    expect(amount.status).toBe(400);
    const numeric = await ctx.http().patch(`/v1/merchants/${id}/profile`).set(bearer(ownerToken)).send({ average_ticket_size: 100.5 });
    expect(numeric.status).toBe(400);
  });

  it('stores bank account and person PAN encrypted, returning only masked values', async () => {
    const { id, ownerToken } = await newMerchant();
    const accountNumber = '123456789012345';
    const res = await ctx.http().post(`/v1/merchants/${id}/bank-accounts`).set(bearer(ownerToken)).send({ account_holder_name: 'X Y', account_number: accountNumber, ifsc: 'ICIC0000004' });
    expect(res.body.data.account_number_masked).toBe('XXXXXXXXXXX2345');
    expect(JSON.stringify(res.body)).not.toContain(accountNumber);
    const row = await ctx.prisma.merchantBankAccount.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.accountNumberEncrypted).not.toContain(accountNumber);
    expect(row.accountNumberEncrypted.startsWith('v1.')).toBe(true);
    const app = await ctx.http().get(`/v1/merchants/${id}`).set(bearer(ownerToken));
    expect(JSON.stringify(app.body)).not.toContain(accountNumber);
    const audits = await ctx.prisma.auditLog.findMany({ where: { organizationId: id } });
    expect(JSON.stringify(audits)).not.toContain(accountNumber);
  });

  it('rejects files whose content is not PDF/PNG/JPEG, and oversize files', async () => {
    const { id, ownerToken } = await newMerchant();
    const html = await upload(ownerToken, id, 'PAN', Buffer.from('<html><script>alert(1)</script></html>'), 'pan.pdf');
    expect(html.status).toBe(400);
    expect(html.body.error.message).toMatch(/PDF, PNG and JPEG/);
    const big = await upload(ownerToken, id, 'PAN', Buffer.concat([pdf(), Buffer.alloc(1024 * 1024 + 10)]), 'big.pdf');
    expect(big.status).toBe(400);
    const ok = await upload(ownerToken, id, 'ADDRESS_PROOF', png(), '../../etc/passwd.png');
    expect(ok.status).toBe(201);
    expect(ok.body.data.file_name).toBe('passwd.png');
    expect(ok.body.data.mime_type).toBe('image/png');
  });

  it('refuses submission of an incomplete application, listing what is missing', async () => {
    const { id, ownerToken } = await newMerchant();
    const res = await ctx.http().post(`/v1/merchants/${id}/submit`).set(bearer(ownerToken));
    expect(res.status).toBe(400);
    const missing = (res.body.error.details as { path: string }[]).map((d) => d.path);
    expect(missing).toEqual(expect.arrayContaining(['profile.identity', 'bank.primary', 'persons.director']));
  });

  it('downloads documents byte-for-byte with audit, and hides them from other tenants', async () => {
    const { id, ownerToken } = await newMerchant();
    const file = pdf('download-check');
    const up = await upload(ownerToken, id, 'PAN', file);
    const res = await ctx.http().get(`/v1/merchants/${id}/documents/${up.body.data.id}/content`).set(bearer(ownerToken)).buffer(true);
    expect(res.status).toBe(200);
    expect(createHash('sha256').update(res.body as Buffer).digest('hex')).toBe(up.body.data.sha256);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'merchant.document.viewed', resourceId: up.body.data.id } })).toBe(1);
    const other = await ctx.http().get(`/v1/merchants/${id}/documents/${up.body.data.id}/content`).set(bearer(otherMerchantToken));
    expect(other.status).toBe(404);
  });
});

describe('compliance workflow', () => {
  it('takes an application from DRAFT to APPROVED with a complete, immutable trail', async () => {
    const { id, ownerToken } = await newMerchant('Approval Journey LLP');
    const { bankId } = await completeApplication(id, ownerToken);

    const submitted = await ctx.http().post(`/v1/merchants/${id}/submit`).set(bearer(ownerToken));
    expect(submitted.status).toBe(200);
    // Locked once submitted.
    const edit = await ctx.http().patch(`/v1/merchants/${id}/profile`).set(bearer(ownerToken)).send({ mcc: '5999' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Approve without review → invalid transition.
    expect((await ctx.http().post(`/v1/merchants/${id}/review/approve`).set(bearer(complianceToken)).send({ reason: 'Looks fine', risk_category: 'LOW', payin_enabled: true, payout_enabled: true })).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await ctx.http().post(`/v1/merchants/${id}/review/start`).set(bearer(complianceToken))).status).toBe(200);

    // Prerequisites not met yet.
    const early = await ctx.http().post(`/v1/merchants/${id}/review/approve`).set(bearer(complianceToken)).send({ reason: 'Looks fine', risk_category: 'LOW', payin_enabled: true, payout_enabled: true });
    expect(early.body.error.code).toBe('KYC_NOT_APPROVED');
    expect((early.body.error.details as { path: string }[]).map((d) => d.path)).toEqual(expect.arrayContaining(['bank.verified', 'screening', 'documents.AGREEMENT.verified']));

    // Request more information → merchant uploads agreement → resubmits.
    expect((await ctx.http().post(`/v1/merchants/${id}/review/request-information`).set(bearer(complianceToken)).send({ reason: 'Please upload the signed merchant agreement' })).status).toBe(200);
    expect((await upload(ownerToken, id, 'AGREEMENT')).status).toBe(201);
    expect((await ctx.http().post(`/v1/merchants/${id}/submit`).set(bearer(ownerToken))).status).toBe(200);
    expect((await ctx.http().post(`/v1/merchants/${id}/review/start`).set(bearer(complianceToken))).status).toBe(200);

    // Reviewer verifies everything.
    const app = (await ctx.http().get(`/v1/merchants/${id}`).set(bearer(complianceToken))).body.data;
    for (const doc of app.documents as { id: string }[]) {
      const r = await ctx.http().post(`/v1/merchants/${id}/documents/${doc.id}/review`).set(bearer(complianceToken)).send({ status: 'VERIFIED' });
      expect(r.status).toBe(200);
    }
    expect((await ctx.http().post(`/v1/merchants/${id}/bank-accounts/${bankId}/verification`).set(bearer(complianceToken)).send({ status: 'VERIFIED', reference: 'PENNY-123' })).status).toBe(200);
    expect((await ctx.http().patch(`/v1/merchants/${id}/screening`).set(bearer(complianceToken)).send({ sanctions_status: 'CLEAR', pep_status: 'CLEAR', adverse_media_status: 'FALSE_POSITIVE', notes: 'Name match on unrelated individual' })).status).toBe(200);

    const approved = await ctx.http().post(`/v1/merchants/${id}/review/approve`).set(bearer(compliance2Token)).send({ reason: 'KYB complete', notes: 'Low-risk electronics retail', risk_category: 'LOW', payin_enabled: true, payout_enabled: false });
    expect(approved.status).toBe(200);

    const final = (await ctx.http().get(`/v1/merchants/${id}`).set(bearer(ownerToken))).body.data;
    expect(final).toMatchObject({ status: 'APPROVED', payin_enabled: true, payout_enabled: false, risk_category: 'LOW' });
    expect(final.screening.risk_notes).toBeUndefined(); // internal notes hidden from merchants
    const trail = (await ctx.http().get(`/v1/merchants/${id}/reviews`).set(bearer(complianceToken))).body.data as { action: string; reason: string; reviewed_by_id: string }[];
    expect(trail.map((t) => t.action).reverse()).toEqual(['CREATED', 'SUBMITTED', 'REVIEW_STARTED', 'INFORMATION_REQUESTED', 'SUBMITTED', 'REVIEW_STARTED', 'APPROVED']);
    expect(trail.every((t) => t.reviewed_by_id)).toBe(true);
    expect(trail[0]!.reason).toBe('KYB complete');

    // Outbox events written transactionally for each transition.
    const events = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: id }, orderBy: { occurredAt: 'asc' } });
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(['merchant.created', 'merchant.submitted', 'merchant.approved']));

    // Compliance history can never be altered.
    const reviewRow = await ctx.prisma.complianceReview.findFirstOrThrow({ where: { merchantId: id } });
    await expect(ctx.prisma.complianceReview.update({ where: { id: reviewRow.id }, data: { reason: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.complianceReview.delete({ where: { id: reviewRow.id } })).rejects.toThrow(/append-only/);
  });

  it('enforces independent review: uploader cannot verify their own document', async () => {
    const { id } = await newMerchant();
    const up = await ctx.http().post(`/v1/merchants/${id}/documents`).set(bearer(complianceToken)).field('type', 'OTHER').attach('file', pdf(), 'x.pdf');
    expect(up.status).toBe(201);
    const res = await ctx.http().post(`/v1/merchants/${id}/documents/${up.body.data.id}/review`).set(bearer(complianceToken)).send({ status: 'VERIFIED' });
    expect(res.body.error.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
  });

  it('lets exactly one of two concurrent reviewers start the review', async () => {
    const { id, ownerToken } = await newMerchant();
    await completeApplication(id, ownerToken);
    await ctx.http().post(`/v1/merchants/${id}/submit`).set(bearer(ownerToken));
    const results = await Promise.all([
      ctx.http().post(`/v1/merchants/${id}/review/start`).set(bearer(complianceToken)),
      ctx.http().post(`/v1/merchants/${id}/review/start`).set(bearer(compliance2Token)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ctx.prisma.complianceReview.count({ where: { merchantId: id, action: 'REVIEW_STARTED' } })).toBe(1);
  });

  it('blocks merchants and resellers from compliance decisions, and services for unapproved merchants', async () => {
    const { id, ownerToken } = await newMerchant();
    expect((await ctx.http().post(`/v1/merchants/${id}/review/start`).set(bearer(ownerToken))).status).toBe(403);
    expect((await ctx.http().post(`/v1/merchants/${id}/review/approve`).set(bearer(resellerToken)).send({ reason: 'self approve', risk_category: 'LOW', payin_enabled: true, payout_enabled: true })).status).toBe(403);
    const settings = await ctx.http().patch(`/v1/merchants/${id}/settings`).set(bearer(complianceToken)).send({ payin_enabled: true, reason: 'enable early' });
    expect(settings.body.error.code).toBe('KYC_NOT_APPROVED');
  });

  it('flags the same settlement account registered to multiple merchants (platform view only)', async () => {
    const a = await newMerchant();
    const b = await newMerchant();
    const body = { account_holder_name: 'Shared Holder', account_number: '998877665544', ifsc: 'SBIN0001234' };
    await ctx.http().post(`/v1/merchants/${a.id}/bank-accounts`).set(bearer(a.ownerToken)).send(body);
    await ctx.http().post(`/v1/merchants/${b.id}/bank-accounts`).set(bearer(b.ownerToken)).send(body);
    const platformView = (await ctx.http().get(`/v1/merchants/${b.id}`).set(bearer(complianceToken))).body.data;
    expect(platformView.bank_accounts[0].shared_with_other_merchants).toBe(true);
    const merchantView = (await ctx.http().get(`/v1/merchants/${b.id}`).set(bearer(b.ownerToken))).body.data;
    expect(merchantView.bank_accounts[0].shared_with_other_merchants).toBe(false);
  });

  it('keeps merchant data tenant-isolated', async () => {
    const { id } = await newMerchant();
    expect((await ctx.http().get(`/v1/merchants/${id}`).set(bearer(otherMerchantToken))).status).toBe(404);
    const nimbus = await orgBySlug(ctx, 'nimbus-software');
    expect((await ctx.http().get(`/v1/merchants/${nimbus.id}`).set(bearer(resellerToken))).status).toBe(404);
    const list = (await ctx.http().get('/v1/merchants?limit=100').set(bearer(resellerToken))).body.data as { id: string }[];
    expect(list.map((m) => m.id)).not.toContain(nimbus.id);
  });
});

describe('limits and approval policies', () => {
  it('resolves system defaults and lets resellers only tighten them', async () => {
    const { id } = await newMerchant();
    const eff = (await ctx.http().get(`/v1/limits/effective?merchant_id=${id}`).set(bearer(resellerToken))).body.data;
    expect(eff.payout.per_transaction_max).toEqual({ value: '200000.00', source: 'SYSTEM' });

    const ok = await ctx.http().put('/v1/limits').set(bearer(resellerToken)).send({ level: 'MERCHANT', subject_id: id, service: 'PAYOUT', per_transaction_max: '50000.00', daily_count: 100, reason: 'New merchant ramp-up' });
    expect(ok.status).toBe(200);
    const after = (await ctx.http().get(`/v1/limits/effective?merchant_id=${id}`).set(bearer(resellerToken))).body.data;
    expect(after.payout.per_transaction_max).toEqual({ value: '50000.00', source: 'MERCHANT' });
    expect(after.payout.daily_count).toEqual({ value: 100, source: 'MERCHANT' });

    const loose = await ctx.http().put('/v1/limits').set(bearer(resellerToken)).send({ level: 'MERCHANT', subject_id: id, service: 'PAYOUT', per_transaction_max: '900000.00', reason: 'Trying to exceed caps' });
    expect(loose.body.error.code).toBe('LIMIT_EXCEEDED');
    const system = await ctx.http().put('/v1/limits').set(bearer(resellerToken)).send({ level: 'SYSTEM', service: 'PAYOUT', per_transaction_max: '1.00', reason: 'Not allowed' });
    expect(system.status).toBe(403);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'limits.updated', organizationId: id } })).toBe(1);
  });

  it('lets merchants tighten (never loosen) their maker-checker policy', async () => {
    const { id, ownerToken } = await newMerchant();
    const stricter = await ctx.http().put('/v1/approval-policies').set(bearer(ownerToken)).send({
      level: 'MERCHANT', subject_id: id, maker_checker_enabled: true, reason: 'Two approvers above 50k',
      tiers: [{ up_to: '5000.00', approvals_required: 0 }, { up_to: '50000.00', approvals_required: 1 }, { up_to: null, approvals_required: 2 }],
    });
    expect(stricter.status).toBe(200);
    const looser = await ctx.http().put('/v1/approval-policies').set(bearer(ownerToken)).send({
      level: 'MERCHANT', subject_id: id, maker_checker_enabled: false, reason: 'Disable approvals', tiers: [{ up_to: null, approvals_required: 0 }],
    });
    expect(looser.status).toBe(403);
    const eff = (await ctx.http().get(`/v1/approval-policies/effective?merchant_id=${id}`).set(bearer(ownerToken))).body.data;
    expect(eff.source).toBe('MERCHANT');
    expect(eff.tiers[0]).toEqual({ up_to_minor: '500000', approvals_required: 0 });
  });
});

describe('sales CRM', () => {
  it('converts a lead into a draft merchant exactly once, carrying the sales owner', async () => {
    const salesToken = (await loginWithMfaEnrollment(ctx, 'sales@pay2all.local')).accessToken;
    const lead = await ctx.http().post('/v1/sales/leads').set(bearer(salesToken)).send({ company_name: 'Lead To Merchant Co', contact_name: 'Ravi K', contact_email: 'ravi@lead.example', source: 'event', notes: 'Met at expo' });
    expect(lead.status).toBe(201);
    const note = await ctx.http().patch(`/v1/sales/leads/${lead.body.data.id}`).set(bearer(salesToken)).send({ status: 'QUALIFIED', note: 'Needs payouts too' });
    expect(note.body.data.notes).toHaveLength(2);

    const [a, b] = await Promise.all([
      ctx.http().post(`/v1/sales/leads/${lead.body.data.id}/convert`).set(bearer(salesToken)).send({ reseller_id: resellerId }),
      ctx.http().post(`/v1/sales/leads/${lead.body.data.id}/convert`).set(bearer(salesToken)).send({ reseller_id: resellerId }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const merchantId = (a.status === 200 ? a : b).body.data.merchant_id as string;
    const merchant = (await ctx.http().get(`/v1/merchants/${merchantId}`).set(bearer(salesToken))).body.data;
    expect(merchant).toMatchObject({ status: 'DRAFT', source: `lead:${lead.body.data.id}`, reseller: { id: resellerId } });
    expect(merchant.profile.contact_email).toBe('ravi@lead.example');
  });
});
