import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { scrubEvent } from './errors';
import { initMetrics, metrics, registry, statusClass } from './metrics';
import { startMetricsServer } from './server';

describe('scrubEvent', () => {
  it('drops request bodies, headers, query strings, users and breadcrumbs', () => {
    const event = scrubEvent({
      request: { method: 'POST', url: 'https://api.example/v1/payouts?token=abc', data: { password: 'x' }, headers: { authorization: 'Bearer t' }, cookies: { rt: 'r' } },
      user: { email: 'a@b.c' },
      breadcrumbs: [{ message: 'otp 123456' }],
      extra: { nested: { refresh_token: 'r', account_number: '123', ok: 1 } },
    });
    expect(event.request).toEqual({ method: 'POST', url: 'https://api.example/v1/payouts' });
    expect(event.user).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.extra).toEqual({ nested: { refresh_token: '[REDACTED]', account_number: '[REDACTED]', ok: 1 } });
  });
});

describe('metrics server', () => {
  initMetrics('test');
  const servers: Array<{ close(): void }> = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it('serves Prometheus text on /metrics only and enforces the optional token', async () => {
    metrics.httpRequests.inc({ method: 'GET', route: '/v1/payments', status_class: statusClass(200) });
    const server = await startMetricsServer({ port: 0, host: '127.0.0.1', registry, token: 'scrape-token' });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/other`, { headers: { authorization: 'Bearer scrape-token' } })).status).toBe(404);
    const ok = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer scrape-token' } });
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(body).toContain('http_server_requests_total{method="GET",route="/v1/payments",status_class="2xx",service="test"} 1');
    expect(body).toContain('process_cpu_user_seconds_total');
  });
});
