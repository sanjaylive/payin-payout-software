import { newId } from '@pay2all/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestContext, createUser, login, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let owner: string; // Sharma owner (webhook.manage)
let viewer: string; // Sharma viewer (no webhook.read)
let kirana: string;
let ops: string;
let sharmaId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  sharmaId = (await orgBySlug(ctx, 'sharma-electronics')).id;
  owner = (await login(ctx, 'owner@sharma-electronics.local')).accessToken!;
  viewer = (await login(ctx, (await createUser(ctx, { roleKey: 'MERCHANT_VIEWER', organizationId: sharmaId })).email)).accessToken!;
  kirana = (await login(ctx, 'owner@kirana-fresh.local')).accessToken!;
  const platform = await orgBySlug(ctx, 'pay2all');
  ops = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'OPERATIONS', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  await ctx.app.close();
});

describe('webhook endpoints', () => {
  it('returns the signing secret exactly once and stores it encrypted', async () => {
    const res = await ctx.http().post('/v1/webhooks/endpoints').set(bearer(owner)).send({ url: 'https://merchant.example/hooks', events: ['payment.success', 'refund.success'], description: 'Main' });
    expect(res.status).toBe(201);
    const secret = res.body.data.secret as string;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(res.body.data.secret_hint).toBe(`whsec_…${secret.slice(-4)}`);
    const row = await ctx.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: res.body.data.endpoint_id } });
    expect(row.secretEncrypted).not.toContain(secret.slice(6));
    const list = await ctx.http().get('/v1/webhooks/endpoints').set(bearer(owner));
    expect(JSON.stringify(list.body)).not.toContain(secret);
    const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: row.id } });
    expect(JSON.stringify(audits)).not.toContain(secret);

    const rotated = await ctx.http().post(`/v1/webhooks/endpoints/${row.id}/rotate-secret`).set(bearer(owner));
    expect(rotated.body.data.secret).not.toBe(secret);
    const after = await ctx.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.secretEncrypted).not.toBe(row.secretEncrypted);
    expect(after.previousSecretEncrypted).toBe(row.secretEncrypted); // old secret still signs during the overlap
    expect(rotated.body.data.previous_secret_valid_until).not.toBeNull();
  });

  it('validates URLs and event types', async () => {
    const bad = async (body: Record<string, unknown>) => (await ctx.http().post('/v1/webhooks/endpoints').set(bearer(owner)).send(body)).status;
    expect(await bad({ url: 'ftp://merchant.example/x' })).toBe(400);
    expect(await bad({ url: 'https://user:pass@merchant.example/x' })).toBe(400);
    expect(await bad({ url: 'https://merchant.example/x', events: ['payment.everything'] })).toBe(400);
  });

  it('is tenant-scoped and permission-gated', async () => {
    const created = await ctx.http().post('/v1/webhooks/endpoints').set(bearer(owner)).send({ url: 'https://merchant.example/scoped' });
    const id = created.body.data.endpoint_id as string;
    expect((await ctx.http().patch(`/v1/webhooks/endpoints/${id}`).set(bearer(kirana)).send({ status: 'DISABLED' })).status).toBe(404);
    expect((await ctx.http().get('/v1/webhooks/endpoints').set(bearer(viewer))).status).toBe(403);
    const k = await ctx.http().get('/v1/webhooks/endpoints').set(bearer(kirana));
    expect(k.body.data.map((e: { endpoint_id: string }) => e.endpoint_id)).not.toContain(id);
  });

  it('sends a test event and exposes the delivery log; replay re-queues it', async () => {
    const created = await ctx.http().post('/v1/webhooks/endpoints').set(bearer(owner)).send({ url: 'https://merchant.example/test' });
    const id = created.body.data.endpoint_id as string;
    const t = await ctx.http().post(`/v1/webhooks/endpoints/${id}/test`).set(bearer(owner));
    expect(t.status).toBe(202);
    const deliveryId = t.body.data.delivery_id as string;
    // Simulate a failed attempt recorded by the worker.
    await ctx.prisma.webhookDeliveryAttempt.create({ data: { id: newId('webhookAttempt'), deliveryId, attemptNo: 1, statusCode: 500, durationMs: 120, responseSnippet: 'oops' } });
    await ctx.prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'FAILED', attempts: 1, lastStatusCode: 500, nextAttemptAt: null } });

    const detail = await ctx.http().get(`/v1/webhooks/deliveries/${deliveryId}`).set(bearer(owner));
    expect(detail.body.data).toMatchObject({ status: 'FAILED', event_type: 'webhook.test', attempt_log: [{ attempt_no: 1, status_code: 500, response_snippet: 'oops' }] });
    expect(detail.body.data.payload.type).toBe('webhook.test');
    const list = await ctx.http().get('/v1/webhooks/deliveries').query({ endpoint_id: id }).set(bearer(owner));
    expect(list.body.data).toHaveLength(1);
    expect((await ctx.http().get(`/v1/webhooks/deliveries/${deliveryId}`).set(bearer(kirana))).status).toBe(404);

    const retry = await ctx.http().post(`/v1/webhooks/deliveries/${deliveryId}/retry`).set(bearer(owner));
    expect(retry.body.data.status).toBe('PENDING');
    await ctx.http().patch(`/v1/webhooks/endpoints/${id}`).set(bearer(owner)).send({ status: 'DISABLED' }).expect(200);
    expect((await ctx.http().post(`/v1/webhooks/deliveries/${deliveryId}/retry`).set(bearer(owner))).status).toBe(400);
  });

  it('lists the merchant event log', async () => {
    const res = await ctx.http().get('/v1/webhooks/events').set(bearer(owner));
    expect(res.status).toBe(200);
    expect(res.body.data.every((e: { merchant_id: string }) => e.merchant_id === sharmaId)).toBe(true);
  });
});

describe('event pipeline (platform)', () => {
  it('reports health and requeues dead letters through a fresh outbox row', async () => {
    const health = await ctx.http().get('/v1/system/events/health').set(bearer(ops));
    expect(health.body.data).toHaveProperty('outbox_backlog');
    expect((await ctx.http().get('/v1/system/events/health').set(bearer(owner))).status).toBe(403);

    const id = newId('deadLetter');
    const envelope = { event_id: newId('outboxEvent'), event_type: 'payment.success', aggregate_type: 'payment', aggregate_id: 'pay_X', version: 1, occurred_at: new Date().toISOString(), request_id: null, payload: { event_id: 'evt_X', merchant_id: sharmaId } };
    await ctx.prisma.deadLetterEvent.create({ data: { id, consumerGroup: 'webhook-dispatcher', topic: 'pay2all.payment', partition: 0, offset: '42', eventId: envelope.event_id, eventType: envelope.event_type, aggregateId: 'pay_X', error: 'boom', attempts: 5, envelope } });
    const list = await ctx.http().get('/v1/system/events/dead-letters').set(bearer(ops));
    expect(list.body.data.some((d: { id: string }) => d.id === id)).toBe(true);
    const rq = await ctx.http().post(`/v1/system/events/dead-letters/${id}/requeue`).set(bearer(ops));
    expect(rq.body.data).toEqual({ requeued: true });
    const fresh = await ctx.prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: 'pay_X', eventType: 'payment.success', publishedAt: null }, orderBy: { occurredAt: 'desc' } });
    expect(fresh.payload).toEqual(envelope.payload);
    expect((await ctx.http().post(`/v1/system/events/dead-letters/${id}/requeue`).set(bearer(ops))).status).toBe(409);
  });
});
