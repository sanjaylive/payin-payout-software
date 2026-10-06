import { describe, expect, it } from 'vitest';
import { dlqTopicFor, isBlockedAddress, signWebhook, topicFor, verifyWebhookSignature } from './index';

describe('topics', () => {
  it('maps aggregates to stable topic names', () => {
    expect(topicFor('payout')).toBe('pay2all.payout');
    expect(topicFor('Provider Status')).toBe('pay2all.provider_status');
    expect(dlqTopicFor('pay2all.payout')).toBe('pay2all.payout.dlq');
  });
});

describe('webhook signatures', () => {
  const body = '{"id":"evt_1","type":"payment.success"}';
  it('verifies a fresh signature and rejects tampering, wrong secrets and stale timestamps', () => {
    const t = 1_760_000_000;
    const h = signWebhook('whsec_a', body, t);
    expect(verifyWebhookSignature('whsec_a', h, body, t + 10)).toBe(true);
    expect(verifyWebhookSignature('whsec_a', h, body.replace('success', 'failed'), t)).toBe(false);
    expect(verifyWebhookSignature('whsec_b', h, body, t)).toBe(false);
    expect(verifyWebhookSignature('whsec_a', h, body, t + 301)).toBe(false);
    expect(verifyWebhookSignature('whsec_a', undefined, body, t)).toBe(false);
  });
  it('accepts any v1 during secret rotation', () => {
    const t = 1_760_000_000;
    const old = signWebhook('whsec_old', body, t).split(',')[1];
    expect(verifyWebhookSignature('whsec_old', `${signWebhook('whsec_new', body, t)},${old}`, body, t)).toBe(true);
    const both = signWebhook(['whsec_new', 'whsec_old'], body, t);
    expect(verifyWebhookSignature('whsec_new', both, body, t)).toBe(true);
    expect(verifyWebhookSignature('whsec_old', both, body, t)).toBe(true);
  });
});

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1'])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '13.235.1.1', '2606:4700:4700::1111'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
  it('treats non-literals as blocked (must be resolved first)', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
  });
});
