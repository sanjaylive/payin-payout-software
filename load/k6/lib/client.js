// Signed Pay2All API client for k6 (docs/API.md §2). Same recipe as the Node example:
//   HMAC-SHA256(secret, `${ts}.${nonce}.${METHOD}.${pathWithQuery}.${sha256hex(body)}`)
import crypto from 'k6/crypto';
import http from 'k6/http';

/** 32 random hex chars (no remote jslib: load tests must run offline). */
export function randomHex() {
  return Array.from(new Uint8Array(crypto.randomBytes(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const BASE_URLS = (__ENV.BASE_URLS || 'http://host.docker.internal:4100').split(',');

/** Credentials written by seed-loadtest (one entry per merchant). */
export function loadKeys() {
  const raw = __ENV.PAY2ALL_KEYS;
  if (!raw) throw new Error('PAY2ALL_KEYS is not set — run the seed-loadtest script first (docs/perf/README.md)');
  return JSON.parse(raw);
}

let rr = 0;
function base() {
  rr = (rr + 1) % BASE_URLS.length;
  return BASE_URLS[rr];
}

export function signedRequest(cred, method, path, body, tags = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomHex();
  const bodyHash = crypto.sha256(raw, 'hex');
  const signature = crypto.hmac('sha256', cred.secret, `${ts}.${nonce}.${method}.${path}.${bodyHash}`, 'hex');
  const headers = {
    'Content-Type': 'application/json',
    'X-Pay2All-Key': cred.key,
    'X-Pay2All-Timestamp': ts,
    'X-Pay2All-Nonce': nonce,
    'X-Pay2All-Signature': `v1=${signature}`,
  };
  if (method === 'POST') headers['Idempotency-Key'] = randomHex();
  return http.request(method, `${base()}${path}`, raw || null, { headers, tags });
}

export function rupees(minMinor, maxMinor) {
  const minor = minMinor + Math.floor(Math.random() * (maxMinor - minMinor));
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export const orderId = (prefix) => `${prefix}_${randomHex().slice(0, 24)}`;
