import { execFileSync } from 'node:child_process';
import { createHmac, createSign, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FieldEncryptor, newId } from '@pay2all/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReceiptsService, suppressionIndex } from '../src/modules/messaging-receipts/receipts.service';
import { snsStringToSign, type SnsMessage } from '../src/modules/messaging-receipts/sns';
import { bearer, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let superAdmin: string;
let sms21Id: string;
let sesId: string;
const WHSEC = `whsec_${randomBytes(18).toString('base64url')}`;
const TOPIC = 'arn:aws:sns:ap-south-1:123456789012:pay2all-ses-events';
const CERT_URL = 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0000.pem';
let key: string;
let cert: string;

/** A throwaway self-signed certificate standing in for AWS's SNS signing certificate. */
function makeCert() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sns-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=sns.amazonaws.com'], { stdio: 'pipe' });
  return { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'c.pem'), 'utf8') };
}

function sns(type: SnsMessage['Type'], message: unknown, extra: Partial<SnsMessage> = {}): string {
  const m: SnsMessage = { Type: type, MessageId: randomUUID(), TopicArn: TOPIC, Message: typeof message === 'string' ? message : JSON.stringify(message), Timestamp: new Date().toISOString(), SignatureVersion: '2', Signature: '', SigningCertURL: CERT_URL, ...extra };
  m.Signature = createSign('RSA-SHA256').update(snsStringToSign(m)).sign(key, 'base64');
  return JSON.stringify(m);
}

async function sentNotification(serviceId: string, channel: 'SMS' | 'EMAIL', providerMessageId: string) {
  const id = newId('notification');
  await ctx.prisma.notification.create({ data: { id, channel, template: 'test', recipientMasked: 'x***', status: 'SENT', messagingServiceId: serviceId, providerMessageId, sentAt: new Date() } });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  ({ key, cert } = makeCert());
  const platform = await orgBySlug(ctx, 'pay2all');
  superAdmin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id })).email)).accessToken;
  sms21Id = (await ctx.prisma.messagingService.findFirstOrThrow({ where: { adapter: 'sms21', channel: 'SMS' } })).id;
  sesId = (await ctx.prisma.messagingService.findFirstOrThrow({ where: { adapter: 'ses' } })).id;
  ctx.app.get(ReceiptsService).fetchText = async (url: string) => {
    if (url === CERT_URL) return cert;
    if (url.startsWith('https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription')) return '<ConfirmSubscriptionResponse/>';
    throw new Error(`unexpected fetch ${url}`);
  };
});

afterAll(async () => {
  await ctx.app.close();
});

describe('sms21 delivery receipts', () => {
  const post = (body: object, opts: { secret?: string; t?: number } = {}) => {
    const raw = JSON.stringify(body);
    const t = opts.t ?? Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', opts.secret ?? WHSEC).update(`${t}.${raw}`).digest('hex');
    return ctx.http().post(`/v1/webhooks/messaging/sms21/${sms21Id}`).set('Content-Type', 'application/json').set('SMS21-Signature', `t=${t},v1=${sig}`).send(raw);
  };
  const event = (messageId: string, status: string, at = new Date()) => ({ id: `evt_${randomBytes(13).toString('hex').slice(0, 26)}`, event: `message.${status}`, timestamp: at.toISOString(), messageId, status, channel: 'sms', type: 'transactional', environment: 'live', failure: status === 'failed' ? { code: 'DELIVERY_FAILED' } : null });

  it('credentials merge: the webhook secret is added without re-entering the API key', async () => {
    await ctx.http().put(`/v1/messaging-services/${sms21Id}/credentials`).set(bearer(superAdmin)).send({ secret: { api_key: 'sms21_test_abcdefghijk' } }).expect(200);
    const r = await ctx.http().put(`/v1/messaging-services/${sms21Id}/credentials`).set(bearer(superAdmin)).send({ secret: { webhook_secret: WHSEC } });
    expect(r.status).toBe(200);
    expect(r.body.data.secret_fingerprints).toMatchObject({ api_key: '…hijk', webhook_secret: `…${WHSEC.slice(-4)}` });
  });

  it('applies signed receipts once, never backwards, and refuses bad or stale signatures', async () => {
    const msg = `msg_${randomBytes(13).toString('hex').slice(0, 26)}`;
    const nid = await sentNotification(sms21Id, 'SMS', msg);
    const delivered = event(msg, 'delivered');
    expect((await post(delivered)).body.data).toMatchObject({ applied: true });
    expect((await post(delivered)).body.data).toMatchObject({ duplicate: true });
    // An earlier "sent" arriving late doesn't undo "delivered".
    expect((await post(event(msg, 'sent', new Date(Date.now() - 60_000)))).body.data).toMatchObject({ applied: false });
    expect(await ctx.prisma.notification.findUniqueOrThrow({ where: { id: nid } })).toMatchObject({ deliveryStatus: 'DELIVERED' });

    expect((await post(event(msg, 'failed'), { secret: 'whsec_wrongwrongwrongwrong' })).status).toBe(401);
    expect((await post(event(msg, 'failed'), { t: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await ctx.http().post('/v1/webhooks/messaging/sms21/msv_00000000000000000000000000').send({})).status).toBe(404);
  });
});

describe('Amazon SES receipts via SNS', () => {
  const post = (body: string) => ctx.http().post(`/v1/webhooks/messaging/ses/${sesId}`).set('Content-Type', 'text/plain; charset=UTF-8').send(body);

  it('verifies SNS, confirms the subscription, records deliveries and suppresses bounced / complaining addresses', async () => {
    // Not configured for a topic yet: refused.
    expect((await post(sns('Notification', {}))).status).toBe(401);
    const svc = await ctx.prisma.messagingService.findUniqueOrThrow({ where: { id: sesId } });
    await ctx.prisma.messagingService.update({ where: { id: sesId }, data: { config: { ...(svc.config as object), sns_topic_arn: TOPIC } } });

    const confirm = await post(sns('SubscriptionConfirmation', 'You have chosen to subscribe', { Token: 'tok', SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok' }));
    expect(confirm.body.data).toMatchObject({ confirmed: true });

    const delivered = `ses-${randomUUID()}`;
    const n1 = await sentNotification(sesId, 'EMAIL', delivered);
    expect((await post(sns('Notification', { eventType: 'Delivery', mail: { messageId: delivered }, delivery: { timestamp: new Date().toISOString() } }))).body.data).toMatchObject({ applied: true });
    expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: n1 } })).deliveryStatus).toBe('DELIVERED');

    const bounced = `ses-${randomUUID()}`;
    const n2 = await sentNotification(sesId, 'EMAIL', bounced);
    await post(sns('Notification', { notificationType: 'Bounce', mail: { messageId: bounced }, bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'Gone.User@Example.com', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] } }));
    expect(await ctx.prisma.notification.findUniqueOrThrow({ where: { id: n2 } })).toMatchObject({ deliveryStatus: 'BOUNCED', deliveryDetail: 'smtp; 550 5.1.1 user unknown' });
    const enc = ctx.app.get(FieldEncryptor);
    expect(await ctx.prisma.emailSuppression.findUnique({ where: { emailIndex: suppressionIndex(enc, 'gone.user@example.com') } })).toMatchObject({ reason: 'BOUNCE', masked: 'g***@example.com' });

    await post(sns('Notification', { eventType: 'Complaint', mail: { messageId: `ses-${randomUUID()}` }, complaint: { complainedRecipients: [{ emailAddress: 'angry@example.com' }], complaintFeedbackType: 'abuse' } }));
    const list = await ctx.http().get('/v1/messaging/suppressions').set(bearer(superAdmin));
    expect(list.body.data.map((s: { email: string }) => s.email)).toEqual(expect.arrayContaining(['g***@example.com', 'a***@example.com']));
    expect(JSON.stringify(list.body)).not.toContain('angry@example.com');
    const angry = list.body.data.find((s: { email: string }) => s.email === 'a***@example.com');
    await ctx.http().delete(`/v1/messaging/suppressions/${angry.id}`).set(bearer(superAdmin)).expect(200);

    const stats = await ctx.http().get(`/v1/messaging/services/${sesId}/delivery`).set(bearer(superAdmin));
    expect(stats.body.data).toMatchObject({ DELIVERED: 1, BOUNCED: 1 });
  });

  it('refuses forged SNS messages: wrong signature, foreign topic, non-AWS certificate host', async () => {
    const good = JSON.parse(sns('Notification', { eventType: 'Delivery', mail: { messageId: 'x' } })) as SnsMessage;
    expect((await post(JSON.stringify({ ...good, Message: '{"eventType":"Delivery","mail":{"messageId":"y"}}' }))).status).toBe(401);
    expect((await post(sns('Notification', {}, { TopicArn: 'arn:aws:sns:ap-south-1:999999999999:other' }))).status).toBe(401);
    expect((await post(sns('Notification', {}, { SigningCertURL: 'https://evil.example.com/cert.pem' }))).status).toBe(401);
    expect((await post(sns('Notification', {}, { SigningCertURL: 'https://sns.ap-south-1.amazonaws.com.evil.com/x.pem' }))).status).toBe(401);
  });
});
