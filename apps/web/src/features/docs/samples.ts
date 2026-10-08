/**
 * Code samples for the API reference. Every language uses the same small signing helper (shown once
 * in Authentication), so each endpoint sample is one readable call.
 */
export type Lang = 'node' | 'python' | 'php' | 'curl';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'node', label: 'Node.js' },
  { id: 'python', label: 'Python' },
  { id: 'php', label: 'PHP' },
  { id: 'curl', label: 'cURL' },
];

export function helpers(base: string): Record<Lang, string> {
  return {
    node: `// pay2all.js — Node 18+ (no dependencies)
import { createHash, createHmac, randomUUID } from 'node:crypto';

const BASE = '${base}';
const KEY = process.env.PAY2ALL_KEY;       // pk_test_… (public key id)
const SECRET = process.env.PAY2ALL_SECRET; // sk_test_… (never sent, never in the browser)

export async function pay2all(method, path, body, { idempotencyKey } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(raw).digest('hex');
  const signature = createHmac('sha256', SECRET)
    .update(\`\${ts}.\${nonce}.\${method}.\${path}.\${bodyHash}\`)
    .digest('hex');
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Pay2All-Key': KEY,
      'X-Pay2All-Timestamp': ts,
      'X-Pay2All-Nonce': nonce,
      'X-Pay2All-Signature': \`v1=\${signature}\`,
      ...(method === 'POST' ? { 'Idempotency-Key': idempotencyKey ?? randomUUID() } : {}),
    },
    body: raw || undefined,
  });
  const json = await res.json();
  if (!json.success) throw Object.assign(new Error(json.error.message), json.error);
  return json.data;
}`,
    python: `# pay2all.py — Python 3.8+, pip install requests
import hashlib, hmac, json, os, time, uuid
import requests

BASE = "${base}"
KEY, SECRET = os.environ["PAY2ALL_KEY"], os.environ["PAY2ALL_SECRET"]

def pay2all(method, path, body=None, idempotency_key=None):
    raw = "" if body is None else json.dumps(body, separators=(",", ":"))
    ts, nonce = str(int(time.time())), str(uuid.uuid4())
    body_hash = hashlib.sha256(raw.encode()).hexdigest()
    message = f"{ts}.{nonce}.{method}.{path}.{body_hash}".encode()
    signature = hmac.new(SECRET.encode(), message, hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "X-Pay2All-Key": KEY,
        "X-Pay2All-Timestamp": ts,
        "X-Pay2All-Nonce": nonce,
        "X-Pay2All-Signature": f"v1={signature}",
    }
    if method == "POST":
        headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
    res = requests.request(method, BASE + path, data=raw or None, headers=headers, timeout=30).json()
    if not res["success"]:
        raise RuntimeError(f'{res["error"]["code"]}: {res["error"]["message"]}')
    return res["data"]`,
    php: `<?php // pay2all.php — PHP 8+, ext-curl
const PAY2ALL_BASE = '${base}';

function pay2all(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): array {
    $raw = $body === null ? '' : json_encode($body, JSON_UNESCAPED_SLASHES);
    $ts = (string) time();
    $nonce = bin2hex(random_bytes(16));
    $bodyHash = hash('sha256', $raw);
    $signature = hash_hmac('sha256', "$ts.$nonce.$method.$path.$bodyHash", getenv('PAY2ALL_SECRET'));
    $headers = [
        'Content-Type: application/json',
        'X-Pay2All-Key: ' . getenv('PAY2ALL_KEY'),
        "X-Pay2All-Timestamp: $ts",
        "X-Pay2All-Nonce: $nonce",
        "X-Pay2All-Signature: v1=$signature",
    ];
    if ($method === 'POST') $headers[] = 'Idempotency-Key: ' . ($idempotencyKey ?? bin2hex(random_bytes(16)));
    $ch = curl_init(PAY2ALL_BASE . $path);
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30]);
    if ($raw !== '') curl_setopt($ch, CURLOPT_POSTFIELDS, $raw);
    $res = json_decode(curl_exec($ch), true);
    curl_close($ch);
    if (!$res['success']) throw new RuntimeException($res['error']['code'] . ': ' . $res['error']['message']);
    return $res['data'];
}`,
    curl: `# p2a — a tiny shell helper: p2a METHOD PATH [JSON]
p2a() {
  local method=$1 path=$2 body=\${3:-}
  local ts=$(date +%s) nonce=$(uuidgen | tr -d '-')
  local hash=$(printf '%s' "$body" | openssl dgst -sha256 -hex | awk '{print $NF}')
  local sig=$(printf '%s' "$ts.$nonce.$method.$path.$hash" | openssl dgst -sha256 -hmac "$PAY2ALL_SECRET" -hex | awk '{print $NF}')
  curl -sS -X "$method" "${base}$path" \\
    -H "Content-Type: application/json" \\
    -H "X-Pay2All-Key: $PAY2ALL_KEY" -H "X-Pay2All-Timestamp: $ts" \\
    -H "X-Pay2All-Nonce: $nonce" -H "X-Pay2All-Signature: v1=$sig" \\
    $([ "$method" = POST ] && echo "-H Idempotency-Key:$nonce") \\
    \${body:+-d "$body"}
}`,
  };
}

const pyValue = (v: unknown, indent = 0): string => {
  const pad = ' '.repeat(indent);
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (Array.isArray(v)) return `[${v.map((x) => pyValue(x, indent)).join(', ')}]`;
  if (typeof v === 'object') return `{\n${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pad}    "${k}": ${pyValue(x, indent + 4)},`).join('\n')}\n${pad}}`;
  return JSON.stringify(v);
};
const phpValue = (v: unknown, indent = 0): string => {
  const pad = ' '.repeat(indent);
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.map((x) => phpValue(x, indent)).join(', ')}]`;
  if (typeof v === 'object') return `[\n${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pad}    '${k}' => ${phpValue(x, indent + 4)},`).join('\n')}\n${pad}]`;
  return typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : String(v);
};

/** One endpoint call in every language. */
export function call(method: string, path: string, body?: Record<string, unknown>, result = 'data'): Record<Lang, string> {
  const json = body ? JSON.stringify(body, null, 2) : undefined;
  return {
    node: `import { pay2all } from './pay2all.js';\n\nconst ${result} = await pay2all('${method}', '${path}'${json ? `, ${json.replace(/"([a-z_]+)":/g, '$1:')}` : ''});`,
    python: `from pay2all import pay2all\n\n${result} = pay2all("${method}", "${path}"${body ? `, ${pyValue(body)}` : ''})`,
    php: `<?php\nrequire 'pay2all.php';\n\n$${result} = pay2all('${method}', '${path}'${body ? `, ${phpValue(body)}` : ''});`,
    curl: `p2a ${method} '${path}'${body ? ` '${JSON.stringify(body)}'` : ''}`,
  };
}

export const WEBHOOK_VERIFY: Record<Lang, string> = {
  node: `import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const app = express();
// Keep the raw bytes: the signature covers them exactly.
app.post('/webhooks/pay2all', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(process.env.PAY2ALL_WEBHOOK_SECRET, req.get('Pay2All-Signature'), req.body)) return res.sendStatus(400);
  const event = JSON.parse(req.body);
  // Idempotent: the same event id can arrive more than once.
  handle(event).catch(console.error);
  res.sendStatus(200); // acknowledge within 10 s
});

function verify(secret, header = '', raw, tolerance = 300) {
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(\`\${t}.\`).update(raw).digest('hex'));
  return parts.filter(([k]) => k === 'v1').some(([, v]) => {
    const given = Buffer.from(v);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}`,
  python: `import hashlib, hmac, json, time
from flask import Flask, request, abort

app = Flask(__name__)

@app.post("/webhooks/pay2all")
def webhook():
    if not verify(SECRET, request.headers.get("Pay2All-Signature", ""), request.get_data()):
        abort(400)
    event = json.loads(request.get_data())
    handle(event)  # idempotent on event["id"]
    return "", 200

def verify(secret: str, header: str, raw: bytes, tolerance: int = 300) -> bool:
    items = [p.split("=", 1) for p in header.split(",") if "=" in p]
    t = next((int(v) for k, v in items if k == "t"), None)
    if t is None or abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(v, expected) for k, v in items if k == "v1")`,
  php: `<?php
$raw = file_get_contents('php://input');
if (!verify(getenv('PAY2ALL_WEBHOOK_SECRET'), $_SERVER['HTTP_PAY2ALL_SIGNATURE'] ?? '', $raw)) {
    http_response_code(400);
    exit;
}
$event = json_decode($raw, true);
// handle($event) — idempotent on $event['id']
http_response_code(200);

function verify(string $secret, string $header, string $raw, int $tolerance = 300): bool {
    $t = null; $sigs = [];
    foreach (explode(',', $header) as $part) {
        [$k, $v] = array_pad(explode('=', $part, 2), 2, '');
        if ($k === 't') $t = (int) $v;
        if ($k === 'v1') $sigs[] = $v;
    }
    if (!$t || abs(time() - $t) > $tolerance) return false;
    $expected = hash_hmac('sha256', "$t.$raw", $secret);
    foreach ($sigs as $s) if (hash_equals($expected, $s)) return true;
    return false;
}`,
  curl: `# Webhooks are verified by your server, not with cURL.
# To compute a signature by hand for debugging:
printf '%s' "$T.$RAW_BODY" | openssl dgst -sha256 -hmac "$PAY2ALL_WEBHOOK_SECRET" -hex`,
};
