import { randomUUID } from 'node:crypto';
import { newId } from '@pay2all/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ResellerBrandService } from '../src/modules/brand/reseller-brand.service';
import { bearer, createApprovedMerchant, createTestContext, createUser, loginWithMfaEnrollment, orgBySlug, signIn, type TestContext } from './helpers';

let ctx: TestContext;
let reseller: { id: string; token: string };
let merchant: { id: string; owner: string };
const DOMAIN = `pay${Date.now()}.resellerco.in`;
const key = () => `k_${randomUUID().replace(/-/g, '')}`;
// A 32×32 transparent PNG (logos must be at least 24 px tall).
const PNG_32 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAARlDNO4AAAAASUVORK5CYII=', 'base64');

/** A reseller with its own admin, and an approved merchant under it. */
async function setup() {
  const platform = await orgBySlug(ctx, 'pay2all');
  const rid = newId('organization');
  await ctx.prisma.organization.create({ data: { id: rid, slug: `wl-${rid.slice(-8).toLowerCase()}`, name: `Reseller ${rid.slice(-5)}`, type: 'RESELLER', parentId: platform.id } });
  const admin = await createUser(ctx, { roleKey: 'RESELLER', organizationId: rid });
  const token = (await loginWithMfaEnrollment(ctx, admin.email)).accessToken;
  const mid = newId('organization');
  await ctx.prisma.organization.create({ data: { id: mid, slug: `wlm-${mid.slice(-8).toLowerCase()}`, name: `Shop ${mid.slice(-5)}`, type: 'MERCHANT', parentId: rid } });
  await ctx.prisma.merchant.create({ data: { id: mid, status: 'APPROVED', payinEnabled: true, payoutEnabled: true, approvedAt: new Date(), resellerId: rid } });
  await ctx.prisma.merchantProfile.create({ data: { merchantId: mid, displayName: 'Shop under reseller' } });
  await ctx.prisma.merchantKyc.create({ data: { merchantId: mid } });
  const owner = (await signIn(ctx, (await createUser(ctx, { roleKey: 'MERCHANT_OWNER', organizationId: mid })).email)).accessToken!;
  return { reseller: { id: rid, token }, merchant: { id: mid, owner } };
}

beforeAll(async () => {
  ctx = await createTestContext();
  ({ reseller, merchant } = await setup());
});

afterAll(async () => {
  await ctx.app.close();
});

describe('reseller white-label', () => {
  it('the reseller sets its brand; its users and its merchants’ users see it, others don’t', async () => {
    const saved = await ctx.http().put('/v1/reseller/brand').set(bearer(reseller.token)).send({ product_name: 'Acme Pay', short_name: 'AcmePay', primary_color: '#0E7490', support_email: 'help@acme.example.in', login_headline: 'Payments for Acme merchants' });
    expect(saved.status).toBe(200);
    expect(saved.body.data.effective).toMatchObject({ product_name: 'Acme Pay', primary_color: '#0e7490', owner: { organization_id: reseller.id, custom_domain: null } });
    const up = await ctx.http().post('/v1/reseller/brand/assets/LOGO').set(bearer(reseller.token)).attach('file', PNG_32, { filename: 'logo.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const logoUrl = up.body.data.effective.assets.logo.url as string;
    expect(logoUrl).toMatch(new RegExp(`^/v1/brand/r/${reseller.id}/assets/LOGO\\?v=`));
    const img = await ctx.http().get(logoUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');

    expect((await ctx.http().get('/v1/brand/mine').set(bearer(reseller.token))).body.data.product_name).toBe('Acme Pay');
    expect((await ctx.http().get('/v1/brand/mine').set(bearer(merchant.owner))).body.data).toMatchObject({ product_name: 'Acme Pay', login_headline: 'Payments for Acme merchants' });
    const direct = await createApprovedMerchant(ctx);
    expect((await ctx.http().get('/v1/brand/mine').set(bearer(direct.owner))).body.data.owner).toBeUndefined();
    // Merchants can't edit a brand; the public default brand is the platform's.
    expect((await ctx.http().put('/v1/reseller/brand').set(bearer(merchant.owner)).send({ product_name: 'Nope', short_name: 'No' })).status).toBe(403);
    expect((await ctx.http().get('/v1/brand')).body.data.owner).toBeUndefined();
  });

  it('custom domain: proven by DNS TXT, then it serves the brand, hosts checkout links and passes CORS', async () => {
    const set = await ctx.http().post('/v1/reseller/brand/domain').set(bearer(reseller.token)).send({ domain: `https://${DOMAIN.toUpperCase()}/` });
    expect(set.body.data.domain).toMatchObject({ name: DOMAIN, verified: false, dns: { type: 'TXT', name: `_pay2all-verify.${DOMAIN}` } });
    const value = set.body.data.domain.dns.value as string;

    const svc = ctx.app.get(ResellerBrandService);
    svc.resolveTxt = () => Promise.resolve([['something-else']]);
    expect((await ctx.http().post('/v1/reseller/brand/domain/verify').set(bearer(reseller.token))).body.error.message).toMatch(/wasn’t found/);
    // Before verification the domain changes nothing.
    expect((await ctx.http().get(`/v1/brand?host=${DOMAIN}`)).body.data.owner).toBeUndefined();
    svc.resolveTxt = (name) => Promise.resolve(name === `_pay2all-verify.${DOMAIN}` ? [[value.slice(0, 10), value.slice(10)]] : []);
    const ok = await ctx.http().post('/v1/reseller/brand/domain/verify').set(bearer(reseller.token));
    expect(ok.body.data.domain.verified).toBe(true);

    expect((await ctx.http().get(`/v1/brand?host=${DOMAIN}:443`)).body.data).toMatchObject({ product_name: 'Acme Pay', owner: { custom_domain: DOMAIN } });

    // Customer-facing URLs of the reseller's merchants use the domain; the checkout page shows the brand.
    const link = await ctx.http().post('/v1/payment-links').set(bearer(merchant.owner)).set('Idempotency-Key', key()).send({ amount: '99.00', description: 'White-label link' });
    expect(link.body.data.url).toMatch(new RegExp(`^https://${DOMAIN.replace(/\./g, '\\.')}/checkout/`));
    const view = await ctx.http().get(`/v1/public/checkout/${(link.body.data.url as string).split('/').pop()}`);
    expect(view.body.data).toMatchObject({ platform: { name: 'Acme Pay' }, brand: { name: 'Acme Pay', primary_color: '#0e7490' } });

    // CORS: the verified domain is allowed, anything else isn't.
    const pre = await ctx.http().options('/v1/brand').set('Origin', `https://${DOMAIN}`).set('Access-Control-Request-Method', 'GET');
    expect(pre.headers['access-control-allow-origin']).toBe(`https://${DOMAIN}`);
    const evil = await ctx.http().options('/v1/brand').set('Origin', 'https://evil.example.net').set('Access-Control-Request-Method', 'GET');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a domain belongs to one account; the platform’s own domains and junk are refused', async () => {
    const other = (await setup()).reseller;
    await ctx.http().put('/v1/reseller/brand').set(bearer(other.token)).send({ product_name: 'Other Pay', short_name: 'Other' }).expect(200);
    expect((await ctx.http().post('/v1/reseller/brand/domain').set(bearer(other.token)).send({ domain: DOMAIN })).status).toBe(409);
    expect((await ctx.http().post('/v1/reseller/brand/domain').set(bearer(other.token)).send({ domain: 'localhost' })).status).toBe(400);
    expect((await ctx.http().post('/v1/reseller/brand/domain').set(bearer(other.token)).send({ domain: 'not a domain' })).status).toBe(400);
    // Removing the domain returns the merchant's links to the platform domain.
    await ctx.http().post('/v1/reseller/brand/domain/remove').set(bearer(reseller.token)).expect(200);
    const link = await ctx.http().post('/v1/payment-links').set(bearer(merchant.owner)).set('Idempotency-Key', key()).send({ amount: '10.00', description: 'After removal' });
    expect(link.body.data.url).toMatch(/^http:\/\/localhost:3000\/checkout\//);
  });
});
