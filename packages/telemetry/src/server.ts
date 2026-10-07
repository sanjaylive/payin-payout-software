import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Registry } from 'prom-client';

export interface MetricsServerOptions {
  port: number;
  host: string;
  registry: Registry;
  /** Optional bearer token Prometheus must send (defence in depth; the port is internal anyway). */
  token?: string;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Serves GET /metrics on a dedicated internal port — never on the public API listener, so metrics
 * are not reachable through the load balancer. Returns the server so callers can close it on shutdown.
 */
export function startMetricsServer(opts: MetricsServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    if (opts.token && !tokenMatches(req.headers.authorization, opts.token)) {
      res.writeHead(401).end();
      return;
    }
    opts.registry
      .metrics()
      .then((body) => res.writeHead(200, { 'Content-Type': opts.registry.contentType, 'Cache-Control': 'no-store' }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
