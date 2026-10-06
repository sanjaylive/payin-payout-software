import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderContext } from '../interfaces/types';
import { MockPayinProvider } from './payin';
import { MockPayoutProvider } from './payout';

// A ULID from "now" minus an offset so status timing is deterministic.
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function idAt(prefix: string, ms: number) {
  let t = ms;
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = CROCK[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return `${prefix}_${out}${'0'.repeat(16)}`;
}

const ctx: ProviderContext = { providerId: 'prv_m', providerCode: 'mock-upi', environment: 'TEST', credentials: { webhook_secret: 'whsec' }, config: { auto_success_after_ms: 1000 }, requestId: 'req', timeoutMs: 1000 };

describe('mock payin', () => {
  it('creates UPI intents and resolves outcomes deterministically by amount', async () => {
    const m = new MockPayinProvider(ctx);
    const old = idAt('pay', Date.now() - 5000);
    const created = await m.createPayment({ reference: old, amountMinor: 100_000n, currency: 'INR', method: 'UPI_INTENT', expiresAt: new Date(Date.now() + 60_000) });
    expect(created.upiIntent).toMatch(/^upi:\/\/pay\?pa=pay2all\.mock%40upi.*am=1000\.00/);
    expect((await m.getPaymentStatus(created.providerOrderId)).status).toBe('SUCCESS');
    const fresh = await m.createPayment({ reference: idAt('pay', Date.now()), amountMinor: 100_000n, currency: 'INR', method: 'UPI_QR', expiresAt: new Date() });
    expect((await m.getPaymentStatus(fresh.providerOrderId)).status).toBe('PENDING');
    const failing = await m.createPayment({ reference: old, amountMinor: 100_013n, currency: 'INR', method: 'UPI_QR', expiresAt: new Date() });
    expect((await m.getPaymentStatus(failing.providerOrderId)).status).toBe('FAILED');
  });

  it('scripts creation-time rejection and ambiguity', async () => {
    const m = new MockPayinProvider(ctx);
    const base = { reference: idAt('pay', Date.now()), currency: 'INR' as const, method: 'UPI_QR' as const, expiresAt: new Date() };
    await expect(m.createPayment({ ...base, amountMinor: 100_091n })).rejects.toMatchObject({ kind: 'REJECTED' });
    await expect(m.createPayment({ ...base, amountMinor: 100_092n })).rejects.toMatchObject({ kind: 'AMBIGUOUS' });
  });

  it('verifies webhook signatures', () => {
    const m = new MockPayinProvider(ctx);
    const body = Buffer.from(JSON.stringify({ event_id: 'ev1', type: 'payment.status', data: { reference: 'pay_x', status: 'SUCCESS', amount_minor: '100' } }));
    const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(m.verifyWebhook(body, { 'x-mock-signature': sig })).toMatchObject({ valid: true, event: { externalEventId: 'ev1', amountMinor: 100n } });
    expect(m.verifyWebhook(body, { 'x-mock-signature': sig.replace(/^./, '0') }).valid).toBe(false);
    expect(m.verifyWebhook(Buffer.from(body.toString().replace('100', '999')), { 'x-mock-signature': sig }).valid).toBe(false);
  });
});

describe('mock payout', () => {
  const req = (amountMinor: bigint, reference = idAt('att', Date.now() - 5000)) => ({ reference, amountMinor, currency: 'INR' as const, mode: 'IMPS' as const, beneficiary: { name: 'X', accountNumber: '1234567890', ifsc: 'HDFC0001234' }, purpose: 'VENDOR' });

  it('scripts every outcome class by paise', async () => {
    const m = new MockPayoutProvider(ctx);
    await expect(m.createPayout(req(1_000_013n))).rejects.toMatchObject({ kind: 'REJECTED' });
    await expect(m.createPayout(req(1_000_099n))).rejects.toMatchObject({ kind: 'NOT_ATTEMPTED' });
    await expect(m.createPayout(req(1_000_077n))).rejects.toMatchObject({ kind: 'AMBIGUOUS' });
    const ok = await m.createPayout(req(1_000_000n));
    expect((await m.getPayoutStatus(ok.providerReference)).status).toBe('SUCCESS');
    const later = await m.createPayout(req(1_000_017n));
    expect((await m.getPayoutStatus(later.providerReference)).status).toBe('FAILED');
    const returned = await m.createPayout(req(1_000_088n));
    expect((await m.getPayoutStatus(returned.providerReference)).status).toBe('REVERSED');
  });

  it('is idempotent on the reference', async () => {
    const m = new MockPayoutProvider(ctx);
    const r = req(500_000n);
    expect((await m.createPayout(r)).providerReference).toBe((await m.createPayout(r)).providerReference);
  });

  it('verifies beneficiaries', async () => {
    const m = new MockPayoutProvider(ctx);
    expect((await m.verifyBeneficiary({ reference: 'b1', name: 'Abc Vendor', accountNumber: '1234567890', ifsc: 'HDFC0001234' })).registeredName).toBe('ABC VENDOR');
    expect((await m.verifyBeneficiary({ reference: 'b2', name: 'X', accountNumber: '1234560000', ifsc: 'HDFC0001234' })).status).toBe('FAILED');
  });
});
