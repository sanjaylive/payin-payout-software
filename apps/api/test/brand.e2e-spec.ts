import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrandService } from '../src/infra/brand.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, queuedMail, randomIp, type TestContext } from './helpers';

let ctx: TestContext;
let superAdmin: string;
let admin: string;
const reason = 'Brand e2e test';

const png = (w: number, h: number) => {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const brand = {
  product_name: 'Acme Pay',
  short_name: 'Acme',
  company_name: 'Acme Fintech Pvt. Ltd.',
  tagline: 'Payments for everyone',
  primary_color: '#0F766E',
  support_email: 'help@acme.test',
  support_phone: '+91 80 4000 1234',
  website_url: 'https://acme.test',
  login_headline: 'Welcome to Acme Pay',
  login_subtext: 'Collections and payouts in one place.',
  footer_text: 'Acme Fintech Pvt. Ltd. is a technology service provider.',
  reason,
};

async function reset() {
  await ctx.prisma.brandAsset.deleteMany({});
  await ctx.prisma.brandSettings.deleteMany({});
  ctx.app.get(BrandService).invalidate();
}

beforeAll(async () => {
  ctx = await createTestContext();
  const platform = await orgBySlug(ctx, 'pay2all');
  superAdmin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'SUPER_ADMIN', organizationId: platform.id })).email)).accessToken;
  admin = (await loginWithMfaEnrollment(ctx, (await createUser(ctx, { roleKey: 'ADMIN', organizationId: platform.id })).email)).accessToken;
  await reset();
});

afterAll(async () => {
  await reset(); // other suites expect the built-in brand
  await ctx.app.close();
});

describe('brand settings', () => {
  it('is public to read, with built-in defaults', async () => {
    const res = await ctx.http().get('/v1/brand');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ product_name: 'Pay2All Payments', short_name: 'Pay2All', primary_color: null, version: 0, assets: { logo: null, logo_dark: null, icon: null } });
  });

  it('only super admins change it', async () => {
    expect((await ctx.http().put('/v1/brand').set(bearer(admin)).send(brand)).status).toBe(403);
    const m = await createApprovedMerchant(ctx);
    expect((await ctx.http().put('/v1/brand').set(bearer(m.owner)).send(brand)).status).toBe(403);
    expect((await ctx.http().put('/v1/brand').send(brand)).status).toBe(401);
  });

  it('validates: colours, plain text only, URLs', async () => {
    const bad = async (patch: Record<string, unknown>) => (await ctx.http().put('/v1/brand').set(bearer(superAdmin)).send({ ...brand, ...patch })).status;
    expect(await bad({ primary_color: 'red' })).toBe(400);
    expect(await bad({ product_name: 'Acme <script>' })).toBe(400);
    expect(await bad({ website_url: 'javascript:alert(1)' })).toBe(400);
    expect(await bad({ support_email: 'not-an-email' })).toBe(400);
    expect(await bad({ reason: '' })).toBe(400);
  });

  it('saves, applies at once, guards concurrent edits and is audited', async () => {
    const res = await ctx.http().put('/v1/brand').set(bearer(superAdmin)).send({ ...brand, version: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ product_name: 'Acme Pay', primary_color: '#0f766e', version: 1 });
    expect((await ctx.http().get('/v1/brand')).body.data.login_headline).toBe('Welcome to Acme Pay');
    expect((await ctx.http().put('/v1/brand').set(bearer(superAdmin)).send({ ...brand, version: 0 })).status).toBe(409);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'brand.updated' } })).toBeGreaterThanOrEqual(1);
  });

  it('emails use the brand name and support contact', async () => {
    const platform = await orgBySlug(ctx, 'pay2all');
    const user = await createUser(ctx, { roleKey: 'SUPPORT', organizationId: platform.id });
    await ctx.http().post('/v1/auth/password/forgot').set('X-Forwarded-For', randomIp()).send({ identifier: user.email }).expect(200);
    const mail = (await queuedMail(ctx, user.email)).at(-1)!;
    expect(mail.subject).toBe('Reset your Acme password');
    expect(mail.text).toContain('reset your Acme Pay password');
    expect(mail.text).toContain('Support: help@acme.test · +91 80 4000 1234');
    expect(mail.text).not.toContain('Pay2All');
  });

  it('uploads images identified by their bytes and serves them safely', async () => {
    const up = await ctx.http().post('/v1/brand/assets/LOGO').set(bearer(superAdmin)).field('reason', reason).attach('file', png(480, 96), 'logo.png');
    expect(up.status).toBe(201);
    const logo = up.body.data.assets.logo;
    expect(logo).toMatchObject({ content_type: 'image/png', width: 480, height: 96 });

    const img = await ctx.http().get(logo.url).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toContain('immutable');
    expect(img.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(img.headers['content-security-policy']).toContain('sandbox');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect((await ctx.http().get(logo.url).set('If-None-Match', img.headers.etag!)).status).toBe(304);

    // A file named .png that is really an SVG is stored and served as SVG (sandboxed).
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0f766e"/></svg>');
    const icon = await ctx.http().post('/v1/brand/assets/ICON').set(bearer(superAdmin)).field('reason', reason).attach('file', svg, 'icon.png');
    expect(icon.body.data.assets.icon).toMatchObject({ content_type: 'image/svg+xml', width: 64, height: 64 });
  });

  it('rejects unsafe or unsuitable images', async () => {
    const send = (kind: string, buf: Buffer, name: string) => ctx.http().post(`/v1/brand/assets/${kind}`).set(bearer(superAdmin)).field('reason', reason).attach('file', buf, name);
    expect((await send('LOGO', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg')).body.error.message).toMatch(/scripts are not allowed/);
    expect((await send('LOGO', Buffer.from('%PDF-1.7 pretending to be an image'), 'x.png')).status).toBe(400);
    expect((await send('ICON', png(300, 100), 'wide.png')).body.error.message).toMatch(/should be square/);
    expect((await send('LOGO', png(200, 10), 'thin.png')).body.error.message).toMatch(/24 pixels tall/);
    expect((await send('FAVICON', png(64, 64), 'x.png')).status).toBe(400);
    expect((await ctx.http().post('/v1/brand/assets/LOGO').set(bearer(admin)).field('reason', reason).attach('file', png(480, 96), 'logo.png')).status).toBe(403);
  });

  it('removes an image', async () => {
    const before = (await ctx.http().get('/v1/brand')).body.data.assets.logo.url as string;
    const res = await ctx.http().post('/v1/brand/assets/LOGO/remove').set(bearer(superAdmin)).send({ reason });
    expect(res.body.data.assets.logo).toBeNull();
    expect((await ctx.http().get(before)).status).toBe(404);
    expect((await ctx.http().post('/v1/brand/assets/LOGO/remove').set(bearer(superAdmin)).send({ reason })).status).toBe(404);
  });
});
