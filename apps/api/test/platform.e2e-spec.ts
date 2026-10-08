import { newId } from '@pay2all/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestContext, type TestContext, signIn } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.app.close();
});

describe('audit log immutability (database-enforced)', () => {
  it('rejects UPDATE and DELETE on audit_logs even through the ORM', async () => {
    const id = newId('auditLog');
    await ctx.prisma.auditLog.create({ data: { id, actorType: 'SYSTEM', action: 'test.immutability', resourceType: 'test' } });
    await expect(ctx.prisma.auditLog.update({ where: { id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.auditLog.delete({ where: { id } })).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.$executeRaw`TRUNCATE audit_logs`).rejects.toThrow(/append-only/);
    const row = await ctx.prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(row.action).toBe('test.immutability');
  });

  it('never stores secrets in audit values', async () => {
    const rows = await ctx.prisma.auditLog.findMany({ take: 500, orderBy: { createdAt: 'desc' } });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/Test-Seed-Password/);
    expect(serialized).not.toMatch(/\$argon2id\$/);
  });
});

describe('HTTP contract', () => {
  it('wraps unknown routes in the error envelope with a request id', async () => {
    const res = await ctx.http().get('/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(res.body.error.request_id).toMatch(/^req_/);
    expect(res.headers['x-request-id']).toBe(res.body.error.request_id);
  });

  it('rejects malformed JSON with INVALID_REQUEST', async () => {
    const res = await ctx.http().post('/v1/auth/login').set('Content-Type', 'application/json').send('{"identifier":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('reports field-level validation details', async () => {
    const res = await ctx.http().post('/v1/auth/login').send({ identifier: 'x', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['identifier', 'password']));
  });

  it('ignores unsafe inbound request ids', async () => {
    const res = await ctx.http().get('/health/live').set('X-Request-Id', 'bad id with spaces <script>');
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9A-Z]{26}$/);
  });

  it('sets security headers', async () => {
    const res = await ctx.http().get('/health/live');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns paginated envelopes with opaque cursors', async () => {
    const token = (await signIn(ctx, 'owner@sharma-electronics.local')).accessToken!;
    const page1 = await ctx.http().get('/v1/audit-logs?limit=2').set(bearer(token));
    expect(page1.body.meta).toMatchObject({ limit: 2, has_more: true });
    const page2 = await ctx.http().get(`/v1/audit-logs?limit=2&cursor=${page1.body.meta.next_cursor}`).set(bearer(token));
    const ids1 = (page1.body.data as { id: string }[]).map((r) => r.id);
    const ids2 = (page2.body.data as { id: string }[]).map((r) => r.id);
    expect(ids2.some((id) => ids1.includes(id))).toBe(false);
  });

  it('health readiness reports dependencies', async () => {
    const res = await ctx.http().get('/health/ready');
    expect(res.body.data.checks).toEqual({ database: true, redis: true });
  });
});
