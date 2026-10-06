import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ProviderError } from '../interfaces/errors';
import type { ProviderContext } from '../interfaces/types';
import { ProviderAAdapter } from '../provider-a';
import { httpJson } from './client';

let server: Server;
let baseUrl: string;
const seen: { headers: IncomingMessage['headers']; body: string; url: string }[] = [];

const routes: Record<string, (res: ServerResponse) => void> = {
  '/ok': (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"fine":true}'),
  '/rejected': (res) => res.writeHead(422, { 'content-type': 'application/json' }).end('{"error":{"code":"INVALID_IFSC"}}'),
  '/unauthorized': (res) => res.writeHead(401).end('{}'),
  '/throttled': (res) => res.writeHead(429).end('{}'),
  '/broken': (res) => res.writeHead(503).end('upstream down'),
  '/garbage': (res) => res.writeHead(200).end('<html>not json</html>'),
  '/slow': (res) => setTimeout(() => res.writeHead(200).end('{}'), 500),
  '/v1/disbursements': (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"pa_123","status":"queued"}'),
  '/v1/disbursements/pa_123': (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"pa_123","status":"weird"}'),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ headers: req.headers, body, url: req.url ?? '' });
      (routes[req.url ?? ''] ?? ((r: ServerResponse) => r.writeHead(404).end('{}')))(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (path: string, timeoutMs = 2000, url = baseUrl) => httpJson({ providerCode: 'stub', baseUrl: url, method: 'GET', path, timeoutMs, requestId: 'req_t' });
const kindOf = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ProviderError).kind;

describe('HTTP error classification', () => {
  it('maps responses to the taxonomy', async () => {
    expect((await call('/ok')).body).toEqual({ fine: true });
    expect(await kindOf(call('/rejected'))).toBe('REJECTED');
    expect(await kindOf(call('/unauthorized'))).toBe('CONFIGURATION');
    expect(await kindOf(call('/throttled'))).toBe('NOT_ATTEMPTED');
    expect(await kindOf(call('/broken'))).toBe('AMBIGUOUS');
    expect(await kindOf(call('/garbage'))).toBe('AMBIGUOUS');
  });

  it('classifies a timeout after sending as AMBIGUOUS (never safe to fail over)', async () => {
    const err = (await call('/slow', 100).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('AMBIGUOUS');
    expect(err.code).toBe('TIMEOUT');
  });

  it('classifies a refused connection as NOT_ATTEMPTED (safe to fail over)', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = (await call('/ok', 2000, `http://127.0.0.1:${port}`).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('NOT_ATTEMPTED');
    expect(err.code).toBe('ECONNREFUSED');
  });
});

it('classifies an invalid endpoint (blocked port) as CONFIGURATION, never ambiguous', async () => {
  expect(await kindOf(call('/x', 1000, 'http://127.0.0.1:1'))).toBe('CONFIGURATION');
});

describe('provider-a template', () => {
  const ctx = (): ProviderContext => ({ providerId: 'prv_a', providerCode: 'provider-a', environment: 'TEST', credentials: { api_key: 'key_1', api_secret: 'shh' }, config: { base_url: baseUrl }, requestId: 'req_abc', timeoutMs: 2000 });

  it('signs requests and maps disbursement responses', async () => {
    const out = await new ProviderAAdapter(ctx()).createPayout({ reference: 'att_01', amountMinor: 1_000_000n, currency: 'INR', mode: 'IMPS', beneficiary: { name: 'ABC Vendor', accountNumber: '123456789', ifsc: 'HDFC0001234' }, purpose: 'VENDOR_PAYMENT' });
    expect(out).toEqual({ providerReference: 'pa_123', status: 'ACCEPTED', utr: undefined, failureReason: undefined });
    const req = seen.find((s) => s.url === '/v1/disbursements')!;
    const ts = req.headers['x-pa-timestamp'] as string;
    const expected = createHmac('sha256', 'shh').update(`${ts}.POST./v1/disbursements.${createHash('sha256').update(req.body).digest('hex')}`).digest('hex');
    expect(req.headers['x-pa-signature']).toBe(expected);
    expect(req.headers['x-request-id']).toBe('req_abc');
    expect(JSON.parse(req.body)).toMatchObject({ reference_id: 'att_01', amount: '1000000' });
  });

  it('treats an unknown provider status as AMBIGUOUS rather than guessing', async () => {
    expect(await kindOf(new ProviderAAdapter(ctx()).getPayoutStatus('pa_123'))).toBe('AMBIGUOUS');
  });

  it('refuses to run without credentials (CONFIGURATION)', async () => {
    expect(await kindOf(new ProviderAAdapter({ ...ctx(), credentials: {} }).getBalance())).toBe('CONFIGURATION');
  });
});
