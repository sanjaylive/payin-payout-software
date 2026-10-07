import path from 'node:path';
import { createKeyring, FieldEncryptor, newId } from '@pay2all/auth';
import { createPrismaClient } from '@pay2all/database';
import { createLogger } from '@pay2all/logger';
import { config as loadDotenv } from 'dotenv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { messagingSecretAad, NotificationSender } from './notifications';

loadDotenv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
const prisma = createPrismaClient({ url: process.env.TEST_DATABASE_URL!, poolMax: 3 });
const keyId = process.env.ENCRYPTION_KEY_ID ?? 'k1';
const encryptor = new FieldEncryptor(createKeyring(keyId, { [keyId]: process.env.ENCRYPTION_KEY! }));
const logger = createLogger({ service: 'test', level: 'silent' });

/** Scriptable stand-in for api.sms21.in: each call takes the next scripted response. */
const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
let script: Array<{ status: number; body: unknown }> = [];
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(init?.body as string) as Record<string, unknown> });
  const next = script.shift() ?? { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'unscripted' } } };
  return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const accepted = (id: string) => ({ status: 202, body: { success: true, messageId: id, status: 'queued' } });
const failure = (status: number, code: string) => ({ status, body: { success: false, error: { code, message: code }, requestId: 'req_test' } });

const created: string[] = [];
let vendorId = '';

async function service(channel: 'SMS' | 'WHATSAPP', priority: number, opts: { status?: 'ACTIVE' | 'DISABLED'; templates?: Record<string, { template_id: string; variables: string[] }> } = {}) {
  const id = newId('messagingService');
  await prisma.messagingService.create({
    data: {
      id,
      vendorId,
      channel,
      adapter: 'sms21',
      name: `sms21 ${channel} p${priority}`,
      priority,
      status: opts.status ?? 'ACTIVE',
      config: { base_url: 'https://api.sms21.in/v1', templates: opts.templates ?? {} },
      secretEncrypted: encryptor.encrypt(JSON.stringify({ api_key: `sms21_test_key${priority}abcdef` }), messagingSecretAad(id)),
    },
  });
  created.push(id);
  return id;
}

/** Same encrypted format as the API's NotificationsService.queue. */
async function notification(channel: 'SMS' | 'WHATSAPP', template: string, variables: Record<string, string>, targetServiceId: string | null = null) {
  const id = newId('notification');
  await prisma.notification.create({
    data: {
      id,
      channel,
      template,
      recipientMasked: '91******3210',
      targetServiceId,
      contentEncrypted: encryptor.encrypt(JSON.stringify({ to: '919876543210', subject: '', text: 'Your Pay2All alert', variables }), `notification:${id}`),
      nextAttemptAt: new Date(),
    },
  });
  return id;
}

const sender = () => new NotificationSender(prisma, encryptor, logger, { smtpUrl: '', from: 'test@pay2all.local', fetchImpl: fakeFetch });
const get = (id: string) => prisma.notification.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  vendorId = newId('apiVendor');
  await prisma.apiVendor.create({ data: { id: vendorId, code: `sms21-${vendorId.slice(-8).toLowerCase()}`, name: 'SMS21 (test)' } });
});

afterEach(async () => {
  calls.length = 0;
  script = [];
  // Routing is per channel and global: never leave these services on for other tests.
  await prisma.messagingService.updateMany({ where: { id: { in: created } }, data: { status: 'DISABLED' } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('SMS / WhatsApp through sms21', () => {
  it('sends a DLT template SMS with the notification id as the idempotency key, then wipes the content', async () => {
    const svc = await service('SMS', 10, { templates: { payout_alert: { template_id: 'tmpl_01k55q8y4m3d9v7x2c6b0n1r8t', variables: ['amount', 'utr'] } } });
    const id = await notification('SMS', 'payout_alert', { amount: '1,000.00', utr: 'UTR123', unrelated: 'never sent' });
    script = [accepted('msg_01k55q8y4m3d9v7x2c6b0n1r8a')];
    await sender().sendDue(1, id);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.sms21.in/v1/sms/send');
    expect(calls[0]!.headers['X-API-Key']).toBe('sms21_test_key10abcdef');
    expect(calls[0]!.headers['Idempotency-Key']).toBe(id);
    expect(calls[0]!.body).toEqual({ to: '919876543210', templateId: 'tmpl_01k55q8y4m3d9v7x2c6b0n1r8t', variables: { amount: '1,000.00', utr: 'UTR123' } });
    expect(await get(id)).toMatchObject({ status: 'SENT', messagingServiceId: svc, providerMessageId: 'msg_01k55q8y4m3d9v7x2c6b0n1r8a', contentEncrypted: null });
  });

  it('falls back to the next service when the first is unavailable, and records the failure', async () => {
    const primary = await service('SMS', 1);
    const secondary = await service('SMS', 2);
    const id = await notification('SMS', 'test', {});
    script = [failure(503, 'SERVICE_UNAVAILABLE'), accepted('msg_01k55q8y4m3d9v7x2c6b0n1r8b')];
    await sender().sendDue(1, id);

    expect(calls.map((c) => c.headers['X-API-Key'])).toEqual(['sms21_test_key1abcdef', 'sms21_test_key2abcdef']);
    expect(calls[0]!.body).toEqual({ to: '919876543210', text: 'Your Pay2All alert' }); // no template mapped: free text
    expect(await get(id)).toMatchObject({ status: 'SENT', messagingServiceId: secondary });
    expect((await prisma.messagingService.findUniqueOrThrow({ where: { id: primary } })).lastError).toContain('SERVICE_UNAVAILABLE');
  });

  it('does not retry or fall back when the message itself is rejected', async () => {
    await service('SMS', 1);
    await service('SMS', 2);
    const id = await notification('SMS', 'test', {});
    script = [failure(400, 'TEMPLATE_NOT_APPROVED')];
    await sender().sendDue(1, id);
    expect(calls).toHaveLength(1);
    const n = await get(id);
    expect(n).toMatchObject({ status: 'FAILED', contentEncrypted: null });
    expect(n.error).toContain('TEMPLATE_NOT_APPROVED');
  });

  it('retries later (content kept) when every service fails transiently', async () => {
    await service('SMS', 1);
    const id = await notification('SMS', 'test', {});
    script = [failure(429, 'RATE_LIMITED')];
    await sender().sendDue(1, id);
    const n = await get(id);
    expect(n).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(n.contentEncrypted).not.toBeNull();
    expect(n.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it('WhatsApp uses the approved template endpoint, or a session text without one', async () => {
    await service('WHATSAPP', 1, { templates: { kyc_approved: { template_id: 'wtpl_01k55q8y4m3d9v7x2c6b0n1r8t', variables: ['name'] } } });
    const tpl = await notification('WHATSAPP', 'kyc_approved', { name: 'Rohit' });
    const text = await notification('WHATSAPP', 'test', {});
    script = [accepted('msg_01k55q8y4m3d9v7x2c6b0n1r8c'), accepted('msg_01k55q8y4m3d9v7x2c6b0n1r8d')];
    await sender().sendDue(1, tpl);
    await sender().sendDue(1, text);
    expect(calls.map((c) => c.url)).toEqual(['https://api.sms21.in/v1/whatsapp/template', 'https://api.sms21.in/v1/whatsapp/send']);
    expect(calls[0]!.body).toEqual({ to: '919876543210', templateId: 'wtpl_01k55q8y4m3d9v7x2c6b0n1r8t', variables: { name: 'Rohit' } });
  });

  it('a test send targets exactly one service, even while it is disabled', async () => {
    await service('SMS', 1);
    const off = await service('SMS', 50, { status: 'DISABLED' });
    const id = await notification('SMS', 'test', {}, off);
    script = [accepted('msg_01k55q8y4m3d9v7x2c6b0n1r8e')];
    await sender().sendDue(1, id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['X-API-Key']).toBe('sms21_test_key50abcdef');
    expect(await get(id)).toMatchObject({ status: 'SENT', messagingServiceId: off });
  });

  it('with no active service for the channel, waits for one to be configured', async () => {
    const id = await notification('SMS', 'test', {});
    await sender().sendDue(1, id);
    expect(calls).toHaveLength(0);
    expect(await get(id)).toMatchObject({ status: 'QUEUED', attempts: 1, error: 'No active SMS service is configured' });
  });
});
