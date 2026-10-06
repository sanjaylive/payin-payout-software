'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pay2all/ui/components/ui/tabs';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { API_URL } from '@/lib/api/client';

const NODE = `import { createHash, createHmac, randomUUID } from 'node:crypto';

const KEY = process.env.PAY2ALL_KEY;       // pk_test_…
const SECRET = process.env.PAY2ALL_SECRET; // sk_test_… (never send it)

export async function pay2all(method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(raw).digest('hex');
  const sig = createHmac('sha256', SECRET).update(\`\${ts}.\${nonce}.\${method}.\${path}.\${bodyHash}\`).digest('hex');
  const res = await fetch('${API_URL}' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Pay2All-Key': KEY,
      'X-Pay2All-Timestamp': String(ts),
      'X-Pay2All-Nonce': nonce,
      'X-Pay2All-Signature': \`v1=\${sig}\`,
      ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
    },
    body: raw || undefined,
  });
  return res.json();
}

await pay2all('POST', '/v1/payments', { merchant_order_id: 'ORD-1001', amount: '1000.00', method: 'UPI' });`;

const PYTHON = `import hashlib, hmac, json, os, time, uuid, requests

KEY, SECRET = os.environ["PAY2ALL_KEY"], os.environ["PAY2ALL_SECRET"]

def pay2all(method, path, body=None):
    raw = "" if body is None else json.dumps(body, separators=(",", ":"))
    ts, nonce = str(int(time.time())), str(uuid.uuid4())
    body_hash = hashlib.sha256(raw.encode()).hexdigest()
    sig = hmac.new(SECRET.encode(), f"{ts}.{nonce}.{method}.{path}.{body_hash}".encode(), hashlib.sha256).hexdigest()
    headers = {"Content-Type": "application/json", "X-Pay2All-Key": KEY, "X-Pay2All-Timestamp": ts,
               "X-Pay2All-Nonce": nonce, "X-Pay2All-Signature": f"v1={sig}"}
    if method == "POST":
        headers["Idempotency-Key"] = str(uuid.uuid4())
    return requests.request(method, "${API_URL}" + path, data=raw or None, headers=headers).json()

pay2all("GET", "/v1/payments?limit=10")`;

const CURL = `TS=$(date +%s); NONCE=$(uuidgen); BODY='{"merchant_order_id":"ORD-1002","amount":"499.00","method":"UPI"}'
HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
SIG=$(printf '%s' "$TS.$NONCE.POST./v1/payments.$HASH" | openssl dgst -sha256 -hmac "$PAY2ALL_SECRET" -hex | awk '{print $2}')
curl -s ${API_URL}/v1/payments \\
  -H "Content-Type: application/json" -H "X-Pay2All-Key: $PAY2ALL_KEY" \\
  -H "X-Pay2All-Timestamp: $TS" -H "X-Pay2All-Nonce: $NONCE" -H "X-Pay2All-Signature: v1=$SIG" \\
  -H "Idempotency-Key: $NONCE" -d "$BODY"`;

const Code = ({ children }: { children: string }) => <pre className="bg-muted overflow-x-auto rounded-lg p-4 text-[12px] leading-5">{children}</pre>;

export function ApiDocs() {
  return (
    <div className="space-y-6">
      <Card className="shadow-none">
        <CardHeader><CardTitle className="text-base">Authentication</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Create a key under <Link href="/developers/api-keys" className="text-primary hover:underline">API keys</Link>. Every request is signed with the key’s secret; the secret itself is never sent.</p>
          <table className="w-full text-left text-sm">
            <tbody className="divide-y">
              {[
                ['X-Pay2All-Key', 'Your key ID (pk_test_… / pk_live_…)'],
                ['X-Pay2All-Timestamp', 'Unix seconds; must be within 5 minutes of our clock'],
                ['X-Pay2All-Nonce', 'A fresh random value per request (16–64 chars, e.g. a UUID); each is accepted once'],
                ['X-Pay2All-Signature', 'v1=hex(HMAC-SHA256(secret, "<timestamp>.<nonce>.<METHOD>.<path with query>.<sha256 hex of raw body>"))'],
                ['Idempotency-Key', 'Required on POST /v1/payments, /v1/payouts and refunds; retries with the same key return the original result'],
                ['X-Pay2All-Merchant', 'API partners only: the merchant (org_…) you are acting for'],
              ].map(([h, d]) => (
                <tr key={h}><td className="py-2 pr-4 align-top font-mono text-xs whitespace-nowrap">{h}</td><td className="text-muted-foreground py-2">{d}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted-foreground">Sign the exact bytes you send. GET requests sign the hash of an empty body. Amounts are rupee strings like <code>{`"1000.00"`}</code>; JSON numbers are rejected.</p>
        </CardContent>
      </Card>
      <Tabs defaultValue="node">
        <TabsList><TabsTrigger value="node">Node.js</TabsTrigger><TabsTrigger value="python">Python</TabsTrigger><TabsTrigger value="curl">cURL</TabsTrigger></TabsList>
        <TabsContent value="node" className="mt-3"><Code>{NODE}</Code></TabsContent>
        <TabsContent value="python" className="mt-3"><Code>{PYTHON}</Code></TabsContent>
        <TabsContent value="curl" className="mt-3"><Code>{CURL}</Code></TabsContent>
      </Tabs>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ['Errors', 'Every error is { success: false, error: { code, message, request_id } }. Quote the request_id to support.'],
          ['Rate limits', '600 requests/minute per key by default. Responses carry RateLimit-Limit / -Remaining / -Reset; over the limit you get 429 with Retry-After.'],
          ['Security', 'Restrict keys to your servers with the IP allowlist, give each integration its own key, and rotate keys regularly (old keys keep working for 24 h).'],
        ].map(([t, d]) => (
          <Card key={t} className="shadow-none"><CardHeader><CardTitle className="text-base">{t}</CardTitle></CardHeader><CardContent className="text-muted-foreground text-sm">{d}</CardContent></Card>
        ))}
      </div>
      <p className="text-sm">
        Endpoint reference: <a className="text-primary inline-flex items-center gap-1 hover:underline" href={`${API_URL}/docs`} target="_blank" rel="noreferrer">OpenAPI / Swagger <ExternalLink className="size-3" /></a> (when enabled for your environment) · Webhooks: <Link className="text-primary hover:underline" href="/developers/webhooks">configure endpoints</Link>.
      </p>
    </div>
  );
}
