import { randomUUID } from 'node:crypto';
import { FieldEncryptor } from '@pay2all/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notificationAad } from '../src/infra/notifications.service';
import { messagingSecretAad } from '../src/modules/vendors/vendors.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
const code = () => `v-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  // Messaging routing is global: leave nothing switched on for other suites.
  await ctx.prisma.messagingService.updateMany({ data: { status: 'DISABLED' } });
  await ctx.app.close();
});

const post = (path: string, body: unknown) => ctx.http().post(path).set(bearer(admin)).send(body as object);

describe('API vendor master', () => {
  it('existing payment providers were migrated under vendors', async () => {
    const list = await ctx.http().get('/v1/vendors').set(bearer(admin));
    expect(list.status).toBe(200);
    const mock = list.body.data.find((v: { code: string }) => v.code === 'mock-upi');
    expect(mock).toMatchObject({ services: ['PAYIN'], payment_services: [expect.objectContaining({ code: 'mock-upi' })] });
  });

  it('groups a bank’s payin and payout services under one vendor', async () => {
    const bank = await post('/v1/vendors', { code: code(), name: 'IDFC FIRST Bank', website: 'https://www.idfcfirstbank.com' });
    expect(bank.status).toBe(201);
    const payout = await ctx.prisma.provider.findUniqueOrThrow({ where: { code: 'mock-payout-2' } });
    const linked = await post(`/v1/vendors/${bank.body.data.vendor_id}/payment-services`, { provider_id: payout.id });
    expect(linked.status).toBe(200);
    expect(linked.body.data).toMatchObject({ services: ['PAYOUT'], payment_services: [expect.objectContaining({ provider_id: payout.id })] });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'vendor.provider_linked', resourceId: payout.id } })).toBe(1);
    expect((await post('/v1/vendors', { code: bank.body.data.code, name: 'Duplicate' })).status).toBe(409);
  });

  it('is platform-only', async () => {
    const m = await createApprovedMerchant(ctx);
    expect((await ctx.http().get('/v1/vendors').set(bearer(m.owner))).status).toBe(403);
  });
});

describe('messaging services', () => {
  it('validates integration config per channel; starts disabled; secrets are write-only and encrypted', async () => {
    const v = (await post('/v1/vendors', { code: code(), name: 'SMS21' })).body.data;
    expect((await post(`/v1/vendors/${v.vendor_id}/messaging-services`, { channel: 'SMS', adapter: 'ses', name: 'Wrong', config: {} })).status).toBe(400);
    expect((await post(`/v1/vendors/${v.vendor_id}/messaging-services`, { channel: 'SMS', adapter: 'sms21', name: 'Bad URL', config: { base_url: 'http://api.sms21.in/v1' } })).status).toBe(400);

    const created = await post(`/v1/vendors/${v.vendor_id}/messaging-services`, {
      channel: 'SMS',
      adapter: 'sms21',
      name: 'SMS21 transactional SMS',
      priority: 10,
      config: { templates: { payout_alert: { template_id: 'tmpl_01k55q8y4m3d9v7x2c6b0n1r8t', variables: ['amount'] } } },
    });
    expect(created.status).toBe(201);
    const s = created.body.data;
    expect(s).toMatchObject({ status: 'DISABLED', has_secret: false, config: { base_url: 'https://api.sms21.in/v1' } });

    // Can't switch on without credentials.
    expect((await ctx.http().patch(`/v1/messaging-services/${s.service_id}`).set(bearer(admin)).send({ status: 'ACTIVE', reason: 'go live' })).status).toBe(400);
    expect((await ctx.http().put(`/v1/messaging-services/${s.service_id}/credentials`).set(bearer(admin)).send({ secret: { api_key: 'not-a-key' } })).status).toBe(400);

    const key = 'sms21_test_abcdefghij1234567890';
    const withKey = await ctx.http().put(`/v1/messaging-services/${s.service_id}/credentials`).set(bearer(admin)).send({ secret: { api_key: key } });
    expect(withKey.status).toBe(200);
    expect(withKey.body.data).toMatchObject({ has_secret: true, secret_fingerprints: { api_key: '…7890' } });
    expect(JSON.stringify(withKey.body)).not.toContain(key);
    const row = await ctx.prisma.messagingService.findUniqueOrThrow({ where: { id: s.service_id } });
    expect(row.secretEncrypted).not.toContain(key);
    expect(JSON.parse(ctx.app.get(FieldEncryptor).decrypt(row.secretEncrypted!, messagingSecretAad(s.service_id)))).toEqual({ api_key: key });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'messaging_service.credentials.rotated', resourceId: s.service_id } });
    expect(JSON.stringify(audit)).not.toContain(key);

    const on = await ctx.http().patch(`/v1/messaging-services/${s.service_id}`).set(bearer(admin)).send({ status: 'ACTIVE', reason: 'tested with a test key' });
    expect(on.body.data).toMatchObject({ status: 'ACTIVE', version: 3 });
    const routing = await ctx.http().get('/v1/messaging-routing').set(bearer(admin));
    expect(routing.body.data.find((r: { channel: string }) => r.channel === 'SMS').services).toEqual(expect.arrayContaining([expect.objectContaining({ service_id: s.service_id, priority: 10 })]));
  });

  it('a test send queues an encrypted notification targeted at exactly that service', async () => {
    const v = (await post('/v1/vendors', { code: code(), name: 'Amazon Web Services' })).body.data;
    const ses = (await post(`/v1/vendors/${v.vendor_id}/messaging-services`, { channel: 'EMAIL', adapter: 'ses', name: 'Amazon SES (Mumbai)', config: { region: 'ap-south-1', from_address: 'no-reply@pay2all.in' } })).body.data;
    expect((await post(`/v1/messaging-services/${ses.service_id}/test`, { to: 'ops@pay2all.in' })).status).toBe(400); // no credentials yet
    await ctx.http().put(`/v1/messaging-services/${ses.service_id}/credentials`).set(bearer(admin)).send({ secret: { access_key_id: 'AKIAEXAMPLEEXAMPLE12', secret_access_key: 'example-secret-access-key-value' } });
    expect((await post(`/v1/messaging-services/${ses.service_id}/test`, { to: 'not-an-email' })).status).toBe(400);

    const res = await post(`/v1/messaging-services/${ses.service_id}/test`, { to: 'ops@pay2all.in' });
    expect(res.status).toBe(202);
    const n = await ctx.prisma.notification.findUniqueOrThrow({ where: { id: res.body.data.notification_id } });
    expect(n).toMatchObject({ channel: 'EMAIL', template: 'test', targetServiceId: ses.service_id, recipientMasked: 'o***@pay2all.in', status: 'QUEUED' });
    const content = JSON.parse(ctx.app.get(FieldEncryptor).decrypt(n.contentEncrypted!, notificationAad(n.id))) as { to: string; subject: string };
    expect(content).toMatchObject({ to: 'ops@pay2all.in', subject: 'Pay2All test message' });
  });

  it('SMS test sends need an international mobile number and are masked in the log', async () => {
    const v = (await post('/v1/vendors', { code: code(), name: 'SMS21 WA' })).body.data;
    const wa = (await post(`/v1/vendors/${v.vendor_id}/messaging-services`, { channel: 'WHATSAPP', adapter: 'sms21', name: 'SMS21 WhatsApp', config: {} })).body.data;
    await ctx.http().put(`/v1/messaging-services/${wa.service_id}/credentials`).set(bearer(admin)).send({ secret: { api_key: 'sms21_test_zyxwvutsrq0987654321' } });
    expect((await post(`/v1/messaging-services/${wa.service_id}/test`, { to: '98765' })).status).toBe(400);
    const res = await post(`/v1/messaging-services/${wa.service_id}/test`, { to: '+91 98765 43210' });
    expect(res.status).toBe(202);
    expect(await ctx.prisma.notification.findUniqueOrThrow({ where: { id: res.body.data.notification_id } })).toMatchObject({ channel: 'WHATSAPP', recipientMasked: '91******3210' });
  });
});
