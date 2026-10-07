import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantReader } from '../src/modules/reports/report-definitions';
import { ReportGeneratorService } from '../src/modules/reports/report-generator.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, login, loginWithMfaEnrollment, orgBySlug, type TestContext } from './helpers';

let ctx: TestContext;
let a: { id: string; owner: string };
let b: { id: string; owner: string };
let admin: string;
const aPayments: string[] = [];
const bPayments: string[] = [];

const key = () => `k_${randomUUID().replace(/-/g, '')}`;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const pay = (token: string, amount: string) =>
  ctx.http().post('/v1/payments').set(bearer(token)).set('Idempotency-Key', key()).send({ merchant_order_id: `rp_${randomUUID().slice(0, 12)}`, amount, method: 'UPI' });
const requestExport = (token: string, body: Record<string, unknown>) => ctx.http().post('/v1/reports/exports').set(bearer(token)).send({ from: today(), to: today(), ...body });
const generator = () => ctx.app.get(ReportGeneratorService);

/** Read the raw download (supertest buffers text/csv as text). */
async function download(token: string, id: string) {
  return ctx.http().get(`/v1/reports/exports/${id}/download`).set(bearer(token)).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  a = await createApprovedMerchant(ctx);
  b = await createApprovedMerchant(ctx);
  for (let i = 0; i < 3; i++) aPayments.push((await pay(a.owner, `${100 + i}.00`)).body.data.payment_id);
  for (let i = 0; i < 2; i++) bPayments.push((await pay(b.owner, '50.00')).body.data.payment_id);
  const platform = await orgBySlug(ctx, 'pay2all');
  admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
});

afterAll(async () => {
  await ctx.app.close();
});

describe('export lifecycle', () => {
  it('queues, generates in the background, and downloads only the requesting merchant’s rows', async () => {
    const req = await requestExport(a.owner, { type: 'PAYMENTS' });
    expect(req.status).toBe(201);
    expect(req.body.data).toMatchObject({ status: 'QUEUED', type: 'PAYMENTS', format: 'CSV', downloadable: false });
    const id = req.body.data.export_id as string;
    expect((await download(a.owner, id)).status).toBe(409); // not ready

    await generator().processQueued();
    const done = await ctx.http().get(`/v1/reports/exports/${id}`).set(bearer(a.owner));
    expect(done.body.data).toMatchObject({ status: 'COMPLETED', row_count: 3, downloadable: true });

    const file = await download(a.owner, id);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['content-disposition']).toContain(`pay2all-payments-${today()}-to-${today()}.csv`);
    const body = file.body as Buffer;
    expect(createHash('sha256').update(body).digest('hex')).toBe(done.body.data.sha256);
    const text = body.toString('utf8');
    expect(text.startsWith('﻿payment_id,merchant_id,merchant_order_id,created_at,status')).toBe(true);
    expect(text).not.toContain('provider_id'); // platform-only column
    for (const p of aPayments) expect(text).toContain(p);
    for (const p of bPayments) expect(text).not.toContain(p);
    expect(text.trimEnd().split('\r\n')).toHaveLength(4);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'report.downloaded', resourceId: id } })).toBe(1);
  });

  it('another tenant cannot see, list or download the export', async () => {
    const id = (await requestExport(a.owner, { type: 'REFUNDS' })).body.data.export_id as string;
    expect((await ctx.http().get(`/v1/reports/exports/${id}`).set(bearer(b.owner))).status).toBe(404);
    expect((await download(b.owner, id)).status).toBe(404);
    const list = await ctx.http().get('/v1/reports/exports').set(bearer(b.owner));
    expect(list.body.data.map((e: { export_id: string }) => e.export_id)).not.toContain(id);
    await generator().processQueued();
  });

  it('validates scope, status, and date range', async () => {
    expect((await requestExport(a.owner, { type: 'PAYMENTS', merchant_id: b.id })).status).toBe(404);
    expect((await requestExport(a.owner, { type: 'PAYMENTS', status: 'BOGUS' })).status).toBe(400);
    expect((await requestExport(a.owner, { type: 'PAYOUTS', status: 'SUCCESS' })).status).toBe(201);
    expect((await requestExport(a.owner, { type: 'PAYMENTS', from: '2026-01-01', to: '2026-06-30' })).status).toBe(400); // > 92 days
    expect((await requestExport(a.owner, { type: 'PAYMENTS', from: '2026-02-02', to: '2026-02-01' })).status).toBe(400);
    expect((await requestExport(a.owner, { type: 'PAYMENTS', format: 'XLSX' })).status).toBe(400); // reserved, not implemented
    await generator().processQueued();
  });

  it('platform exports include internal columns and may narrow to one merchant', async () => {
    const id = (await requestExport(admin, { type: 'PAYMENTS', merchant_id: b.id })).body.data.export_id as string;
    await generator().processQueued();
    const text = ((await download(admin, id)).body as Buffer).toString('utf8');
    expect(text.split('\r\n')[0]).toContain('provider_id');
    for (const p of bPayments) expect(text).toContain(p);
    for (const p of aPayments) expect(text).not.toContain(p);
  });

  it('caps exports in progress per organization', async () => {
    const m = await createApprovedMerchant(ctx);
    for (let i = 0; i < 3; i++) expect((await requestExport(m.owner, { type: 'PAYMENTS' })).status).toBe(201);
    const fourth = await requestExport(m.owner, { type: 'PAYMENTS' });
    expect(fourth.status).toBe(429);
    while ((await generator().processQueued(10)) > 0);
  });

  it('expires files after the retention window', async () => {
    const id = (await requestExport(a.owner, { type: 'SETTLEMENTS' })).body.data.export_id as string;
    await generator().processQueued();
    expect((await ctx.prisma.reportExport.findUniqueOrThrow({ where: { id } })).status).toBe('COMPLETED');
    await ctx.prisma.reportExport.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await generator().expireOld();
    const e = await ctx.prisma.reportExport.findUniqueOrThrow({ where: { id } });
    expect(e).toMatchObject({ status: 'EXPIRED', storageKey: null });
    expect((await download(a.owner, id)).status).toBe(409);
  });
});

describe('row-level security backstop', () => {
  const asReader = <T>(scope: { kind: 'PLATFORM' | 'RESELLER' | 'MERCHANT'; id: string | null }, sql: (tx: Parameters<Parameters<TestContext['prisma']['$transaction']>[0]>[0]) => Promise<T>) =>
    ctx.prisma.$transaction((tx) => withTenantReader(tx, scope, () => sql(tx)));
  const countAll = (tx: { $queryRaw: TestContext['prisma']['$queryRaw'] }) => tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM payments`.then((r) => r[0]!.n);

  it('a query with no tenant filter only sees the scoped merchant’s rows', async () => {
    expect(await asReader({ kind: 'MERCHANT', id: a.id }, countAll)).toBe(3);
    expect(await asReader({ kind: 'MERCHANT', id: b.id }, countAll)).toBe(2);
    expect(await asReader({ kind: 'PLATFORM', id: null }, countAll)).toBe(await ctx.prisma.payment.count());
  });

  it('fails closed when no scope is set, and the reader role cannot write', async () => {
    const unscoped = await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE pay2all_tenant_reader`;
      return countAll(tx);
    });
    expect(unscoped).toBe(0);
    await expect(
      ctx.prisma.$transaction((tx) => withTenantReader(tx, { kind: 'MERCHANT', id: a.id }, () => tx.$executeRaw`UPDATE payments SET description = 'x' WHERE merchant_id = ${a.id}`)),
    ).rejects.toThrow(/permission denied/);
    await expect(ctx.prisma.$transaction((tx) => withTenantReader(tx, { kind: 'MERCHANT', id: a.id }, () => tx.$queryRaw`SELECT count(*) FROM ledger_entries`))).rejects.toThrow(/permission denied/);
  });

  it('reseller scope covers exactly the merchants under that reseller', async () => {
    const reseller = await orgBySlug(ctx, 'acme-partners');
    const children = (await ctx.prisma.organization.findMany({ where: { parentId: reseller.id }, select: { id: true } })).map((o) => o.id);
    const expected = await ctx.prisma.payment.count({ where: { merchantId: { in: children } } });
    expect(await asReader({ kind: 'RESELLER', id: reseller.id }, countAll)).toBe(expected);
    const leaked = await asReader({ kind: 'RESELLER', id: reseller.id }, (tx) => tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM payments WHERE merchant_id = ${a.id}`);
    expect(leaked[0]!.n).toBe(0);
  });

  it('the application role is unaffected after the transaction', async () => {
    await asReader({ kind: 'MERCHANT', id: a.id }, countAll);
    // Same pooled connections, normal role again: sees everything.
    expect(await ctx.prisma.payment.count({ where: { merchantId: { in: [a.id, b.id] } } })).toBe(5);
    expect((await login(ctx, 'owner@sharma-electronics.local')).res.status).toBe(200);
  });
});
