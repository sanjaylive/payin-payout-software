import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUSES, PAYMENT_TRANSITIONS, paymentCanTransition, paymentSourcesFor } from './transitions';

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
