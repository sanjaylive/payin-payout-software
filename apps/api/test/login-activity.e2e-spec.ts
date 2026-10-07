import { FieldEncryptor } from '@pay2all/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notificationAad } from '../src/infra/notifications.service';
import { ReportGeneratorService } from '../src/modules/reports/report-generator.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, randomIp, SEED_PASSWORD, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string; // ADMIN: merchant.integration.manage
let compliance: string; // COMPLIANCE: no merchant.integration.manage
let platformId: string;

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const signIn = (identifier: string, password: string, extra: Record<string, unknown> = {}, ip = randomIp()) =>
  ctx.http().post('/v1/auth/login').set('X-Forwarded-For', ip).set('User-Agent', CHROME_WIN).send({ identifier, password, ...extra });

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  platformId = platform.id;
  admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
  compliance = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'COMPLIANCE', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  await ctx.app.close();
});

describe('login activity', () => {
  it('records each attempt with outcome, IP, device and the browser-shared location', async () => {
    const m = await createApprovedMerchant(ctx);
    const user = await createUser(ctx, { roleKey: 'MERCHANT_FINANCE', organizationId: m.id });
    const bad = await signIn(user.email, 'wrong-password-1', {}, '203.0.113.7');
    expect(bad.status).toBe(401);
    const ok = await signIn(user.email, SEED_PASSWORD, { location: { latitude: 19.07609, longitude: 72.877426, accuracy: 35.4 } }, '203.0.113.8');
    expect(ok.status).toBe(200);
    expect((await signIn(user.email, SEED_PASSWORD, { location: { latitude: 91, longitude: 0 } })).status).toBe(400);

    const rows = await ctx.prisma.loginEvent.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ outcome: 'BAD_PASSWORD', organizationId: m.id, ipAddress: '203.0.113.7', latitude: null });
    expect(rows[1]).toMatchObject({ outcome: 'SUCCESS', organizationId: m.id, ipAddress: '203.0.113.8', browser: 'Chrome 141', os: 'Windows', deviceType: 'desktop', locationAccuracyM: 35, sessionId: expect.stringMatching(/^ses_/) });
    expect(rows[1]!.latitude?.toString()).toBe('19.07609');
    expect(rows[1]!.identifierMasked).toMatch(/^.\*\*\*@test\.local$/);

    // Append-only.
    await expect(ctx.prisma.loginEvent.update({ where: { id: rows[0]!.id }, data: { outcome: 'SUCCESS' } })).rejects.toThrow(/append-only/);
  });

  it('records the two-step MFA sign-in and unknown identifiers', async () => {
    const u = await createUser(ctx, { roleKey: 'SUPPORT', organizationId: platformId });
    await loginWithMfaEnrollment(ctx, u.email);
    const step1 = await signIn(u.email, SEED_PASSWORD);
    expect(step1.body.data.status).toBe('MFA_REQUIRED');
    const bad = await ctx.http().post('/v1/auth/mfa/verify').set('User-Agent', CHROME_WIN).send({ mfa_token: step1.body.data.mfa_token, code: '000000' });
    expect(bad.status).toBe(401);
    const outcomes = (await ctx.prisma.loginEvent.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'asc' } })).map((e) => [e.outcome, e.mfaUsed]);
    expect(outcomes.slice(-2)).toEqual([['MFA_REQUIRED', false], ['MFA_FAILED', true]]);

    await signIn('nobody.at.all@test.local', 'whatever-password');
    expect(await ctx.prisma.loginEvent.findFirst({ where: { identifierMasked: 'n***@test.local', outcome: 'UNKNOWN_USER' } })).toMatchObject({ userId: null, organizationId: null });
  });

  it('is tenant-scoped: merchants see their own; platform can filter by merchant', async () => {
    const a = await createApprovedMerchant(ctx);
    const b = await createApprovedMerchant(ctx);
    const aUser = await createUser(ctx, { roleKey: 'MERCHANT_VIEWER', organizationId: a.id });
    await signIn(aUser.email, SEED_PASSWORD, { location: { latitude: 12.97, longitude: 77.59 } });

    const own = await ctx.http().get('/v1/login-events?result=success').set(bearer(a.owner));
    expect(own.status).toBe(200);
    expect(own.body.data.every((e: { organization_id: string }) => e.organization_id === a.id)).toBe(true);
    expect(own.body.data[0]).toMatchObject({ user_name: 'Test MERCHANT_VIEWER', success: true, location: { latitude: 12.97, longitude: 77.59 } });
    expect((await ctx.http().get(`/v1/login-events?organization_id=${a.id}`).set(bearer(b.owner))).status).toBe(404);

    const platformView = await ctx.http().get(`/v1/login-events?organization_id=${a.id}`).set(bearer(admin));
    expect(platformView.body.data.length).toBeGreaterThan(0);
    const summary = await ctx.http().get(`/v1/login-events/summary?organization_id=${a.id}`).set(bearer(admin));
    expect(summary.body.data).toMatchObject({ attempts: expect.any(Number), last_success_at: expect.any(String) });
  });

  it('exports as an immediate CSV download, audited', async () => {
    const m = await createApprovedMerchant(ctx);
    const u = await createUser(ctx, { roleKey: 'MERCHANT_FINANCE', organizationId: m.id });
    await signIn(u.email, SEED_PASSWORD, { location: { latitude: 28.6139, longitude: 77.209 } }, '198.51.100.20');
    const res = await ctx.http().get(`/v1/login-events/export.csv?organization_id=${m.id}&from=${today()}&to=${today()}`).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(`pay2all-logins-${today()}-to-${today()}.csv`);
    const text = res.text;
    expect(text.split('\r\n')[0]).toBe('﻿time,user,email_or_mobile,outcome,mfa,ip_address,browser,os,device,latitude,longitude,accuracy_m,organization_id,event_id');
    expect(text).toContain('198.51.100.20');
    expect(text).toContain('28.6139');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'login_events.exported', resourceId: m.id } })).toBe(1);
  });

  it('“Email me”: generated in the background, then a link (no data) is emailed to the requester', async () => {
    const m = await createApprovedMerchant(ctx);
    const u = await createUser(ctx, { roleKey: 'MERCHANT_FINANCE', organizationId: m.id });
    await signIn(u.email, SEED_PASSWORD, {}, '198.51.100.33');
    const req = await ctx.http().post('/v1/login-events/export-email').set(bearer(admin)).send({ organization_id: m.id, from: today(), to: today() });
    expect(req.status).toBe(202);
    expect(req.body.data).toMatchObject({ type: 'LOGIN_EVENTS', status: 'QUEUED', notify_by_email: true });

    while ((await ctx.app.get(ReportGeneratorService).processQueued(10)) > 0);
    const exp = await ctx.prisma.reportExport.findUniqueOrThrow({ where: { id: req.body.data.export_id } });
    expect(exp).toMatchObject({ status: 'COMPLETED', rowCount: 2 }); // the owner (fixture sign-in) and this user

    const mail = await ctx.prisma.notification.findFirstOrThrow({ where: { template: 'report_ready' }, orderBy: { createdAt: 'desc' } });
    const content = JSON.parse(ctx.app.get(FieldEncryptor).decrypt(mail.contentEncrypted!, notificationAad(mail.id))) as { subject: string; text: string };
    expect(content.subject).toBe('Your Login activity export is ready');
    expect(content.text).toContain('/admin/reports');
    expect(content.text).not.toContain('198.51.100.33'); // the email never carries the data
  });
});

describe('super admin manages a merchant’s webhooks and IP allowlist', () => {
  it('adds, edits, tests and lists webhook endpoints on the merchant’s behalf', async () => {
    const m = await createApprovedMerchant(ctx);
    const created = await ctx.http().post(`/v1/admin/merchants/${m.id}/webhook-endpoints`).set(bearer(admin)).send({ url: 'https://merchant.example/webhooks/pay2all', events: ['payment.success'], description: 'Set up by onboarding' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ merchant_id: m.id, status: 'ACTIVE', secret: expect.stringMatching(/^whsec_/) });
    const endpointId = created.body.data.endpoint_id as string;

    // The merchant sees it in its own list.
    const own = await ctx.http().get('/v1/webhooks/endpoints').set(bearer(m.owner));
    expect(own.body.data.map((e: { endpoint_id: string }) => e.endpoint_id)).toContain(endpointId);

    const edited = await ctx.http().patch(`/v1/admin/merchants/${m.id}/webhook-endpoints/${endpointId}`).set(bearer(admin)).send({ events: ['payment.success', 'payout.success'] });
    expect(edited.body.data.events).toEqual(['payment.success', 'payout.success']);
    expect((await ctx.http().post(`/v1/admin/merchants/${m.id}/webhook-endpoints/${endpointId}/test`).set(bearer(admin))).status).toBe(202);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'webhook.endpoint.created', resourceId: endpointId } });
    expect(audit.metadata).toMatchObject({ on_behalf: true });

    // Generic route: platform staff still can't re-enable / edit there.
    expect((await ctx.http().patch(`/v1/webhooks/endpoints/${endpointId}`).set(bearer(admin)).send({ events: ['payment.failed'] })).status).toBe(403);
    // Endpoint of another merchant through this merchant's path: not found.
    const other = await createApprovedMerchant(ctx);
    expect((await ctx.http().patch(`/v1/admin/merchants/${other.id}/webhook-endpoints/${endpointId}`).set(bearer(admin)).send({ events: ['payment.failed'] })).status).toBe(404);
  });

  it('manages the API IP allowlist on the merchant’s behalf', async () => {
    const m = await createApprovedMerchant(ctx);
    const add = await ctx.http().post(`/v1/admin/merchants/${m.id}/ip-allowlist`).set(bearer(admin)).send({ cidr: '203.0.113.0/24', label: 'Merchant DC' });
    expect(add.status).toBe(201);
    expect(add.body.data).toMatchObject({ enforced: true, entries: [expect.objectContaining({ cidr: '203.0.113.0/24' })] });
    const own = await ctx.http().get('/v1/developers/ip-allowlist').set(bearer(m.owner));
    expect(own.body.data.entries).toHaveLength(1);
    const removed = await ctx.http().delete(`/v1/admin/merchants/${m.id}/ip-allowlist/${add.body.data.entries[0].entry_id}`).set(bearer(admin));
    expect(removed.body.data).toMatchObject({ enforced: false, entries: [] });
  });

  it('needs merchant.integration.manage and a platform account', async () => {
    const m = await createApprovedMerchant(ctx);
    expect((await ctx.http().post(`/v1/admin/merchants/${m.id}/ip-allowlist`).set(bearer(compliance)).send({ cidr: '203.0.113.9' })).status).toBe(403);
    expect((await ctx.http().post(`/v1/admin/merchants/${m.id}/webhook-endpoints`).set(bearer(m.owner)).send({ url: 'https://x.example/h', events: ['payment.success'] })).status).toBe(403);
    expect((await ctx.http().get(`/v1/admin/merchants/${m.id}/ip-allowlist`).set(bearer(compliance))).status).toBe(200); // read is fine
  });
});
