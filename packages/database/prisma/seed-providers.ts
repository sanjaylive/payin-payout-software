/* eslint-disable no-console */
/**
 * Demo providers and routing rules (development only). Idempotent.
 *  - mock-upi       PAYIN  sandbox (ACTIVE)
 *  - mock-upi-2     PAYIN  sandbox fallback (ACTIVE) — demonstrates failover on rejected orders
 *  - mock-payout    PAYOUT sandbox "Provider 1" (ACTIVE)
 *  - mock-payout-2  PAYOUT sandbox "Provider 2" (ACTIVE)
 *  - provider-a / provider-b  integration templates (DISABLED — no real endpoints)
 * Routes reproduce the spec: ₹0–₹5,000 → Provider 1, ₹5,000.01+ → Provider 2, each falling back to
 * the other, and a merchant-specific rule to a disabled template to show routing explanations.
 */
import { randomBytes } from 'node:crypto';
import { createKeyring, FieldEncryptor, newId } from '@pay2all/auth';
import type { Prisma, PrismaClient } from '../src/index';

const json = (v: unknown) => v as Prisma.InputJsonValue;

export async function seedProviders(db: PrismaClient, sharmaId: string): Promise<void> {
  const keyId = process.env.ENCRYPTION_KEY_ID ?? 'k1';
  const enc = new FieldEncryptor(createKeyring(keyId, { [keyId]: process.env.ENCRYPTION_KEY! }));

  const defs = [
    { code: 'mock-upi', name: 'Sandbox UPI collections', kind: 'PAYIN', adapter: 'mock', status: 'ACTIVE', capabilities: { payin_methods: ['UPI_QR', 'UPI_INTENT', 'PAYMENT_LINK'], min_amount_minor: '100', max_amount_minor: '10000000' }, costs: { payin_rate_micros: '100000' }, config: { auto_success_after_ms: 3000, timeout_ms: 8000 } },
    { code: 'mock-upi-2', name: 'Sandbox UPI collections — fallback', kind: 'PAYIN', adapter: 'mock', status: 'ACTIVE', capabilities: { payin_methods: ['UPI_QR', 'UPI_INTENT', 'PAYMENT_LINK'], min_amount_minor: '100', max_amount_minor: '10000000' }, costs: { payin_rate_micros: '110000' }, config: { auto_success_after_ms: 3000, timeout_ms: 8000, collect_vpa: 'pay2all.mock2@upi', scripted_create_failures: false } },
    { code: 'mock-payout', name: 'Sandbox payouts — Provider 1', kind: 'PAYOUT', adapter: 'mock', status: 'ACTIVE', capabilities: { payout_modes: ['IMPS', 'NEFT', 'UPI'], max_amount_minor: '50000000' }, costs: { payout_flat_minor: '300' }, config: { auto_success_after_ms: 3000, timeout_ms: 10000 } },
    { code: 'mock-payout-2', name: 'Sandbox payouts — Provider 2', kind: 'PAYOUT', adapter: 'mock', status: 'ACTIVE', capabilities: { payout_modes: ['IMPS', 'NEFT', 'RTGS', 'UPI'] }, costs: { payout_flat_minor: '450' }, config: { auto_success_after_ms: 5000, timeout_ms: 10000 } },
    { code: 'provider-a', name: 'Provider A (integration template)', kind: 'BOTH', adapter: 'provider-a', status: 'DISABLED', capabilities: { payin_methods: ['UPI_QR', 'UPI_INTENT'], payout_modes: ['IMPS', 'NEFT'] }, costs: { payin_rate_micros: '90000', payout_flat_minor: '250' }, config: { base_url: 'https://sandbox.provider-a.example', timeout_ms: 10000 } },
    { code: 'provider-b', name: 'Provider B (integration template)', kind: 'PAYOUT', adapter: 'provider-b', status: 'DISABLED', capabilities: { payout_modes: ['IMPS', 'NEFT', 'RTGS'] }, costs: { payout_flat_minor: '200' }, config: { base_url: 'https://sandbox.provider-b.example', timeout_ms: 10000 } },
  ] as const;

  const ids = new Map<string, string>();
  for (const d of defs) {
    const existing = await db.provider.findUnique({ where: { code: d.code } });
    const p =
      existing ??
      (await db.provider.create({
        data: {
          id: newId('provider'),
          code: d.code,
          name: d.name,
          kind: d.kind,
          adapter: d.adapter,
          status: d.status,
          statusSource: d.status === 'ACTIVE' ? 'AUTO' : 'MANUAL',
          statusReason: d.status === 'DISABLED' ? 'Integration template — not connected to a real partner' : null,
          capabilities: json(d.capabilities),
          costs: json(d.costs),
          config: json(d.config),
        },
      }));
    ids.set(d.code, p.id);
    // Every payment service belongs to an API vendor (docs/VENDORS.md); one per provider by default.
    if (!p.vendorId) {
      const vendor = await db.apiVendor.upsert({ where: { code: d.code }, create: { id: newId('apiVendor'), code: d.code, name: d.name }, update: {} });
      await db.provider.update({ where: { id: p.id }, data: { vendorId: vendor.id } });
    }
    if (d.adapter === 'mock' && !(await db.providerCredential.count({ where: { providerId: p.id } }))) {
      const values = { webhook_secret: `whsec_${randomBytes(24).toString('base64url')}` };
      await db.providerCredential.create({
        data: {
          id: newId('providerCredential'),
          providerId: p.id,
          environment: 'TEST',
          secretEncrypted: enc.encrypt(JSON.stringify(values), `${p.id}:TEST`),
          fingerprints: json({ webhook_secret: `…${values.webhook_secret.slice(-4)}` }),
        },
      });
    }
  }

  if ((await db.providerRoute.count()) === 0) {
    const route = (name: string, service: 'PAYIN' | 'PAYOUT', code: string, extra: Partial<Prisma.ProviderRouteUncheckedCreateInput> = {}) => ({ id: newId('providerRoute'), name, service, providerId: ids.get(code)!, ...extra });
    await db.providerRoute.createMany({
      data: [
        route('Default UPI collections', 'PAYIN', 'mock-upi', { tier: 'PRIMARY', priority: 100 }),
        route('Small payouts (up to ₹5,000) → Provider 1', 'PAYOUT', 'mock-payout', { tier: 'PRIMARY', priority: 100, maxAmountMinor: 500_000n }),
        route('Large payouts (above ₹5,000) → Provider 2', 'PAYOUT', 'mock-payout-2', { tier: 'PRIMARY', priority: 100, minAmountMinor: 500_001n }),
        route('Fallback → Provider 2', 'PAYOUT', 'mock-payout-2', { tier: 'FALLBACK', priority: 100 }),
        route('Fallback → Provider 1', 'PAYOUT', 'mock-payout', { tier: 'FALLBACK', priority: 200 }),
        route('Sharma Electronics → Provider A (disabled template)', 'PAYOUT', 'provider-a', { tier: 'PRIMARY', priority: 10, merchantId: sharmaId }),
      ],
    });
  }
  const upi2 = ids.get('mock-upi-2')!;
  if (!(await db.providerRoute.count({ where: { providerId: upi2 } }))) {
    await db.providerRoute.create({ data: { id: newId('providerRoute'), name: 'Fallback UPI collections', service: 'PAYIN', providerId: upi2, tier: 'FALLBACK', priority: 100 } });
  }
  console.log('  Providers: mock-upi, mock-upi-2, mock-payout, mock-payout-2 (active); provider-a, provider-b (disabled templates).');
}
