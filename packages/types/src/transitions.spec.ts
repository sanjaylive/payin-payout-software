import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUSES, PAYMENT_TRANSITIONS, PAYOUT_RESERVED_STATUSES, PAYOUT_TRANSITIONS, paymentCanTransition, paymentSourcesFor, payoutCanTransition } from './transitions';

describe('payment state machine', () => {
  it('forbids backward moves from terminal-ish states', () => {
    expect(paymentCanTransition('SUCCESS', 'PENDING')).toBe(false);
    expect(paymentCanTransition('REFUNDED', 'SUCCESS')).toBe(false);
    expect(paymentCanTransition('CHARGEBACK', 'SUCCESS')).toBe(false);
    expect(paymentCanTransition('SETTLED', 'SUCCESS')).toBe(false);
  });

  it('allows late success only from FAILED/EXPIRED/CANCELLED and the normal path', () => {
    expect(paymentSourcesFor('SUCCESS').sort()).toEqual(['CANCELLED', 'CREATED', 'DISPUTED', 'EXPIRED', 'FAILED', 'PENDING', 'REFUND_PENDING'].sort());
  });

  it('only references known statuses and never self-loops', () => {
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_TRANSITIONS[from]) {
        expect(PAYMENT_STATUSES).toContain(to);
        expect(to).not.toBe(from);
      }
    }
  });
});

describe('payout state machine', () => {
  it('never leaves a terminal state except a bank return after success', () => {
    for (const s of ['FAILED', 'REJECTED', 'REVERSED'] as const) expect(PAYOUT_TRANSITIONS[s]).toEqual([]);
    expect(PAYOUT_TRANSITIONS.SUCCESS).toEqual(['REVERSED']);
  });

  it('rejects the moves PAYOUT_FLOW.md forbids', () => {
    expect(payoutCanTransition('SUCCESS', 'PENDING')).toBe(false);
    expect(payoutCanTransition('FAILED', 'SUCCESS')).toBe(false);
    expect(payoutCanTransition('PENDING', 'QUEUED')).toBe(false); // accepted at a provider: never re-sent
    expect(payoutCanTransition('APPROVAL_PENDING', 'PROCESSING')).toBe(false); // approval can't be skipped
    expect(payoutCanTransition('QUEUED', 'SUCCESS')).toBe(false);
  });

  it('every reserved status can still reach a release path', () => {
    for (const s of PAYOUT_RESERVED_STATUSES) {
      expect(PAYOUT_TRANSITIONS[s].some((t) => t === 'FAILED' || t === 'REJECTED' || t === 'QUEUED' || t === 'PENDING' || t === 'MANUAL_REVIEW')).toBe(true);
    }
  });
});
