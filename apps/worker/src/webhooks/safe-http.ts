import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isBlockedAddress } from '@pay2all/events';

export class UnsafeDestinationError extends Error {}

export interface SafePostResult {
  status: number;
  bodySnippet: string;
  durationMs: number;
}

/**
 * POST with SSRF protection for merchant-supplied URLs:
 *  - every resolved address is checked, and the socket connects to the address that was checked
 *    (custom `lookup`), so DNS rebinding between check and connect is impossible;
 *  - IP-literal hosts are checked directly; redirects are never followed;
 *  - hard timeout, and at most 1 KB of the response body is read.
 */
export function safePost(rawUrl: string, body: string, headers: Record<string, string>, opts: { timeoutMs?: number; allowPrivate?: boolean } = {}): Promise<SafePostResult> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.reject(new UnsafeDestinationError('Only http(s) URLs are allowed'));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!opts.allowPrivate && isIP(host) && isBlockedAddress(host)) return Promise.reject(new UnsafeDestinationError(`Destination ${host} is a private or reserved address`));

  const lookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      const list = addresses as { address: string; family: number }[];
      const allowed = opts.allowPrivate ? list : list.filter((a) => !isBlockedAddress(a.address));
      if (!allowed.length || (!opts.allowPrivate && allowed.length !== list.length)) {
        return callback(new UnsafeDestinationError(`${hostname} resolves to a private or reserved address`), '', 4);
      }
      const chosen = allowed[0]!;
      // Node may ask for all addresses (happy-eyeballs); answer with the validated set only.
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, allowed);
      callback(null, chosen.address, chosen.family);
    });
  };

  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() }, lookup, timeout: timeoutMs, agent: false },
      (res) => {
        let snippet = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (snippet.length < 1024) snippet += chunk.slice(0, 1024 - snippet.length);
          if (snippet.length >= 1024) res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, bodySnippet: snippet, durationMs: Date.now() - started });
        res.on('end', done);
        res.on('close', done);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs} ms`)));
    req.on('error', (err) => reject(err));
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}
