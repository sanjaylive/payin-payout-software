import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createKeyring, FieldEncryptor, newId } from '@pay2all/auth';
import { createPrismaClient } from '@pay2all/database';
import { type EventEnvelope, verifyWebhookSignature } from '@pay2all/events';
import { createLogger } from '@pay2all/logger';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationSender, queueNotification } from '../notifications/notifications';
import { AUTO_DISABLE_AFTER, dispatchMerchantEvent, WebhookSender } from './webhooks';

loadDotenv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
const prisma = createPrismaClient({ url: process.env.TEST_DATABASE_URL!, poolMax: 5 });
const keyId = process.env.ENCRYPTION_KEY_ID ?? 'k1';
const encryptor = new FieldEncryptor(createKeyring(keyId, { [keyId]: process.env.ENCRYPTION_KEY! }));
const logger = createLogger({ service: 'test', level: 'silent' });

// A local merchant receiver with scriptable responses.
const received: { headers: IncomingMessage['headers']; body: string }[] = [];
let respond: (res: import('node:http').ServerResponse) => void = (res) => res.writeHead(200).end('ok');
let server: Server;
let base = '';

async function merchantWithEndpoint(url: string, events: string[] = []) {
  const merchantId = newId('organization');
  await prisma.organization.create({ data: { id: merchantId, slug: `wh-${merchantId.slice(-10).toLowerCase()}`, name: 'Webhook Test', type: 'MERCHANT' } });
  const endpointId = newId('webhookEndpoint');
  const secret = `whsec_${randomUUID()}`;
  await prisma.webhookEndpoint.create({ data: { id: endpointId, merchantId, url, events, secretEncrypted: encryptor.encrypt(secret, `webhook-endpoint:${endpointId}`), secretHint: 'whsec_…test' } });
  return { merchantId, endpointId, secret };
}

async function event(merchantId: string, type = 'payment.success') {
  const id = newId('webhookEvent');
  const payload = { id, type, created_at: new Date().toISOString(), data: { payment_id: 'pay_TEST', amount: '100.00' } };
  await prisma.webhookEvent.create({ data: { id, merchantId, type, payload, resourceId: 'pay_TEST' } });
  const envelope: EventEnvelope = { event_id: newId('outboxEvent'), event_type: type, aggregate_type: 'payment', aggregate_id: 'pay_TEST', version: 1, occurred_at: new Date().toISOString(), request_id: null, payload: { event_id: id, merchant_id: merchantId } };
  return { id, envelope };
}

const dispatch = (env: EventEnvelope) => prisma.$transaction((tx) => dispatchMerchantEvent(tx, env));
const sender = (allowPrivate = true) => new WebhookSender(prisma, encryptor, logger, { allowPrivateTargets: allowPrivate, timeoutMs: 3_000 });
async function sendNow(deliveryId: string, allowPrivate = true) {
  await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { nextAttemptAt: new Date(0) } });
  await prisma.webhookDelivery.updateMany({ where: { status: 'PENDING', NOT: { id: deliveryId } }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
  await sender(allowPrivate).sendDue();
  return prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { attemptLogs: { orderBy: { attemptNo: 'asc' } } } });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      respond(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

describe('webhook dispatch and delivery', () => {
  it('fans out to subscribed endpoints once, and delivers a signed request', async () => {
    const { merchantId, endpointId, secret } = await merchantWithEndpoint(`${base}/hooks`, ['payment.success']);
    const other = await prisma.webhookEndpoint.create({ data: { id: newId('webhookEndpoint'), merchantId, url: `${base}/other`, events: ['payout.success'], secretEncrypted: encryptor.encrypt('x', 'x'), secretHint: 'x' } });
    const { id, envelope } = await event(merchantId);
    expect(await dispatch(envelope)).toBe(1);
    expect(await dispatch(envelope)).toBe(0); // replayed event: no duplicate delivery
    expect(await prisma.webhookDelivery.count({ where: { eventId: id, endpointId: other.id } })).toBe(0);

    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: id, endpointId } });
    respond = (res) => res.writeHead(200).end('thanks');
    const before = received.length;
    const done = await sendNow(d.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempts: 1, lastStatusCode: 200 });
    const req = received[before]!;
    expect(req.headers['pay2all-event-id']).toBe(id);
    expect(req.headers['pay2all-event-type']).toBe('payment.success');
    expect(verifyWebhookSignature(secret, req.headers['pay2all-signature'] as string, req.body)).toBe(true);
    expect(JSON.parse(req.body)).toMatchObject({ id, type: 'payment.success' });
    expect(done.attemptLogs[0]).toMatchObject({ attemptNo: 1, statusCode: 200, responseSnippet: 'thanks' });
  });

  it('retries with backoff on errors, does not follow redirects, then succeeds', async () => {
    const { merchantId } = await merchantWithEndpoint(`${base}/flaky`);
    const { envelope } = await event(merchantId, 'payout.success');
    await dispatch(envelope);
    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { merchantId } });
    respond = (res) => res.writeHead(500).end('down');
    let r = await sendNow(d.id);
    expect(r).toMatchObject({ status: 'PENDING', attempts: 1, lastStatusCode: 500 });
    expect(r.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50_000); // ≈ 1 minute
    respond = (res) => res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
    r = await sendNow(d.id);
    expect(r).toMatchObject({ status: 'PENDING', attempts: 2, lastStatusCode: 302 });
    expect(r.lastError).toContain('redirects are not followed');
    respond = (res) => res.writeHead(204).end();
    r = await sendNow(d.id);
    expect(r).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
    expect(r.attemptLogs.map((a) => a.statusCode)).toEqual([500, 302, 204]);
    const ep = await prisma.webhookEndpoint.findFirstOrThrow({ where: { merchantId } });
    expect(ep.consecutiveFailures).toBe(0);
  });

  it('blocks private and loopback destinations (SSRF) unless explicitly allowed for development', async () => {
    for (const url of [`${base}/x`, `http://localhost:${new URL(base).port}/x`, 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x']) {
      const { merchantId } = await merchantWithEndpoint(url);
      const { envelope } = await event(merchantId);
      await dispatch(envelope);
      const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { merchantId } });
      const before = received.length;
      const r = await sendNow(d.id, false);
      expect(r.lastError).toMatch(/^Blocked:/);
      expect(received.length).toBe(before); // nothing was sent
    }
  });

  it('signs with both secrets during a rotation overlap, and only the new one after it', async () => {
    const { merchantId, endpointId, secret: oldSecret } = await merchantWithEndpoint(`${base}/rotate`);
    const newSecret = `whsec_${randomUUID()}`;
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } });
    await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { secretEncrypted: encryptor.encrypt(newSecret, `webhook-endpoint:${endpointId}`), previousSecretEncrypted: ep.secretEncrypted, previousSecretExpiresAt: new Date(Date.now() + 3_600_000) } });
    respond = (res) => res.writeHead(200).end();
    const send = async () => {
      const { envelope } = await event(merchantId);
      await dispatch(envelope);
      const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { merchantId, status: 'PENDING' } });
      const before = received.length;
      await sendNow(d.id);
      return received[before]!;
    };
    let req = await send();
    expect(verifyWebhookSignature(newSecret, req.headers['pay2all-signature'] as string, req.body)).toBe(true);
    expect(verifyWebhookSignature(oldSecret, req.headers['pay2all-signature'] as string, req.body)).toBe(true);
    await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { previousSecretExpiresAt: new Date(Date.now() - 1000) } });
    req = await send();
    expect(verifyWebhookSignature(newSecret, req.headers['pay2all-signature'] as string, req.body)).toBe(true);
    expect(verifyWebhookSignature(oldSecret, req.headers['pay2all-signature'] as string, req.body)).toBe(false);
  });

  it('auto-disables an endpoint after consecutive failures and emails the merchant admins', async () => {
    const { merchantId, endpointId } = await merchantWithEndpoint(`${base}/dead`);
    const role = await prisma.role.findFirst({ where: { key: 'MERCHANT_OWNER', organizationId: null } });
    if (role) {
      const user = await prisma.user.create({ data: { id: newId('user'), name: 'Owner', email: `owner.${randomUUID().slice(0, 8)}@wh.test`, passwordHash: 'x', status: 'ACTIVE' } });
      await prisma.userRole.create({ data: { id: newId('membership'), userId: user.id, roleId: role.id, organizationId: merchantId } });
    }
    await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { consecutiveFailures: AUTO_DISABLE_AFTER - 1 } });
    const { envelope } = await event(merchantId);
    await dispatch(envelope);
    const d = await prisma.webhookDelivery.findFirstOrThrow({ where: { merchantId } });
    respond = (res) => res.writeHead(503).end();
    await sendNow(d.id);
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } });
    expect(ep).toMatchObject({ status: 'DISABLED', disabledReason: expect.stringContaining('Auto-disabled') as string });
    if (role) expect(await prisma.notification.count({ where: { template: 'webhook_endpoint_disabled', createdAt: { gte: new Date(Date.now() - 60_000) } } })).toBeGreaterThanOrEqual(1);
    // Further due deliveries to a disabled endpoint fail without a request.
    const before = received.length;
    const r = await sendNow(d.id);
    expect(r.status).toBe('FAILED');
    expect(received.length).toBe(before);
  });
});

describe('notifications', () => {
  it('sends through SMTP (Mailpit), then wipes the encrypted content', async () => {
    const to = `notify.${randomUUID().slice(0, 8)}@pay2all.test`;
    const id = await prisma.$transaction((tx) => queueNotification(tx, encryptor, { to, subject: `Reset link ${to}`, text: 'https://app.local/reset?token=one-time-secret', template: 'password_reset' }));
    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(row.contentEncrypted).not.toContain('one-time-secret');
    expect(row.recipientMasked).not.toContain(to);
    const smtp = process.env.SMTP_URL ?? '';
    await new NotificationSender(prisma, encryptor, logger, { smtpUrl: smtp, from: 'Pay2All <no-reply@pay2all.local>' }).sendDue(50, id);
    const sent = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(sent).toMatchObject({ status: 'SENT', contentEncrypted: null, attempts: 1 });
    if (smtp.includes('51025')) {
      const res = await fetch(`http://localhost:58025/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
      const body = (await res.json()) as { messages_count: number };
      expect(body.messages_count).toBe(1);
    }
  });

  it('retries on SMTP failure and gives up (wiping content) after the last attempt', async () => {
    const id = await prisma.$transaction((tx) => queueNotification(tx, encryptor, { to: 'x@pay2all.test', subject: 's', text: 't', template: 'test' }));
    const bad = new NotificationSender(prisma, encryptor, logger, { smtpUrl: 'smtp://127.0.0.1:1', from: 'x@y.z' });
    await bad.sendDue(1, id);
    let n = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(n).toMatchObject({ status: 'QUEUED', attempts: 1 });
    await prisma.notification.update({ where: { id }, data: { attempts: 4, nextAttemptAt: new Date(0) } });
    await bad.sendDue(1, id);
    n = await prisma.notification.findUniqueOrThrow({ where: { id } });
    expect(n).toMatchObject({ status: 'FAILED', contentEncrypted: null, attempts: 5 });
  });
});
