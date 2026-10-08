'use client';

import { Input } from '@pay2all/ui/components/ui/input';
import { cn } from '@pay2all/ui/lib/utils';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Copy, Hash, Info, Search, ShieldCheck } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { API_URL } from '@/lib/api/client';
import { useBrand } from '@/lib/brand/brand-provider';
import { call, helpers, type Lang, LANGS, WEBHOOK_VERIFY } from './samples';

// ---- Language preference (shared by every sample on the page) -------------------------------------

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'node', setLang: () => undefined });

/** The web app's origin (where checkout.js is served), known only in the browser. */
const noopSubscribe = () => () => undefined;
const useWebOrigin = () => useSyncExternalStore(noopSubscribe, () => window.location.origin, () => 'https://pay.example.com');

export const popupSnippet = (origin: string) => `<script src="${origin}/js/v1/checkout.js"></script>
<button id="pay">Pay ₹2,499</button>
<script>
  let sessionId;
  document.getElementById('pay').onclick = () =>
    Pay2All.checkout({
      // Your server creates the session (POST /v1/checkout/sessions).
      // The window opens immediately; the url loads when this resolves.
      url: () =>
        fetch('/api/checkout', { method: 'POST' })
          .then((r) => r.json())
          .then((s) => ((sessionId = s.id), s.url)),
      onSuccess: () => location.assign('/orders/thanks?session=' + sessionId), // verify on your server
      onFailure: (r) => alert('Payment ' + r.status.toLowerCase()),
      onClose: () => fetch('/api/checkout/' + sessionId + '/sync'),          // it may still be paid
    });
</script>`;

// ---- Building blocks ------------------------------------------------------------------------------

function CopyIcon({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy code"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
      className="rounded p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
    >
      {done ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function CodePanel({ title, samples, single }: { title?: string; samples?: Record<Lang, string>; single?: { label: string; code: string } }) {
  const { lang, setLang } = useContext(LangContext);
  const code = single ? single.code : samples![lang];
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 text-slate-100 shadow-sm">
      <div className="flex items-center gap-1 border-b border-slate-800 bg-slate-900/70 px-2 py-1.5">
        {title && <span className="px-2 text-[11px] font-medium tracking-wide text-slate-400 uppercase">{title}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {single ? (
            <span className="px-2 text-[11px] text-slate-400">{single.label}</span>
          ) : (
            LANGS.map((l) => (
              <button key={l.id} type="button" onClick={() => setLang(l.id)} className={cn('rounded px-2 py-1 text-[11px] font-medium transition-colors', lang === l.id ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200')}>
                {l.label}
              </button>
            ))
          )}
          <CopyIcon text={code} />
        </div>
      </div>
      <pre className="max-h-[520px] overflow-auto p-4 font-mono text-[12px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const Json = ({ title = 'Response', value }: { title?: string; value: unknown }) => <CodePanel title={title} single={{ label: 'JSON', code: JSON.stringify(value, null, 2) }} />;

const METHOD_CLS: Record<string, string> = {
  GET: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  POST: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  PUT: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  DELETE: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

interface Param {
  name: string;
  type: string;
  required?: boolean;
  desc: ReactNode;
}

function Params({ title, rows }: { title: string; rows: Param[] }) {
  return (
    <div className="space-y-2">
      <h4 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">{title}</h4>
      <ul className="divide-y rounded-lg border">
        {rows.map((p) => (
          <li key={p.name} className="space-y-1 px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <code className="text-[13px] font-semibold">{p.name}</code>
              <span className="text-muted-foreground font-mono text-[11px]">{p.type}</span>
              {p.required ? <span className="text-[10px] font-semibold tracking-wide text-rose-600 uppercase dark:text-rose-400">Required</span> : <span className="text-muted-foreground text-[10px] tracking-wide uppercase">Optional</span>}
            </div>
            <div className="text-muted-foreground text-sm leading-relaxed">{p.desc}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Anchor({ id }: { id: string }) {
  return (
    <a href={`#${id}`} className="text-muted-foreground hover:text-foreground ml-2 opacity-0 transition-opacity group-hover:opacity-100" aria-label="Link to this section">
      <Hash className="inline size-4" />
    </a>
  );
}

function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} data-doc-section className="scroll-mt-24 border-b py-12 first:pt-0 last:border-b-0">
      <div className={cn('grid gap-8', aside && 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]')}>
        <div className="min-w-0 space-y-4">
          <h2 className="group text-2xl font-semibold tracking-tight">
            {title}
            <Anchor id={id} />
          </h2>
          <div className="text-muted-foreground space-y-4 text-[15px] leading-relaxed [&_strong]:text-foreground [&_code]:bg-muted [&_code]:text-foreground [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px]">{children}</div>
        </div>
        {aside && <div className="min-w-0 space-y-4 xl:sticky xl:top-24 xl:self-start">{aside}</div>}
      </div>
    </section>
  );
}

function Endpoint({ id, method, path, title, children, params, query, body, response, samples }: { id: string; method: string; path: string; title: string; children?: ReactNode; params?: Param[]; query?: Param[]; body?: Record<string, unknown>; response: unknown; samples?: Record<Lang, string> }) {
  return (
    <Section
      id={id}
      title={title}
      aside={
        <>
          <CodePanel title="Request" samples={samples ?? call(method, path.replace(/:(\w+)/g, (_m, k: string) => `{${k}}`), body)} />
          <Json value={response} />
        </>
      }
    >
      <div className="bg-muted/50 flex items-center gap-2 overflow-x-auto rounded-lg border px-3 py-2">
        <span className={cn('rounded px-1.5 py-0.5 font-mono text-[11px] font-bold', METHOD_CLS[method])}>{method}</span>
        <code className="!bg-transparent !p-0 font-mono text-sm whitespace-nowrap">{path}</code>
      </div>
      {children}
      {params && <Params title="Body parameters" rows={params} />}
      {query && <Params title="Query parameters" rows={query} />}
    </Section>
  );
}

function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode }) {
  const Icon = tone === 'warn' ? AlertTriangle : tone === 'ok' ? ShieldCheck : Info;
  return (
    <div className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', tone === 'warn' ? 'border-amber-500/30 bg-amber-500/5' : tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-sky-500/30 bg-sky-500/5')}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'warn' ? 'text-amber-600' : tone === 'ok' ? 'text-emerald-600' : 'text-sky-600')} />
      <div className="text-foreground/90 space-y-1">{children}</div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/50 text-xs">
          <tr>
            {head.map((h) => (
              <th key={h} className="text-foreground px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Navigation -----------------------------------------------------------------------------------

const NAV: { group: string; items: { id: string; label: string; method?: string }[] }[] = [
  { group: 'Get started', items: [{ id: 'introduction', label: 'Introduction' }, { id: 'quickstart', label: 'Quickstart' }, { id: 'authentication', label: 'Authentication' }, { id: 'idempotency', label: 'Idempotency' }, { id: 'errors', label: 'Errors' }, { id: 'pagination', label: 'Pagination' }, { id: 'rate-limits', label: 'Rate limits' }, { id: 'testing', label: 'Testing' }] },
  { group: 'Checkout', items: [{ id: 'checkout', label: 'How checkout works' }, { id: 'checkout-create', label: 'Create a session', method: 'POST' }, { id: 'checkout-retrieve', label: 'Retrieve a session', method: 'GET' }, { id: 'checkout-list', label: 'List sessions', method: 'GET' }, { id: 'checkout-cancel', label: 'Cancel a session', method: 'POST' }, { id: 'checkout-return', label: 'After payment' }, { id: 'checkout-popup', label: 'Popup checkout (checkout.js)' }, { id: 'plugins', label: 'Plugins & SDKs' }] },
  { group: 'Payment links', items: [{ id: 'links', label: 'How links work' }, { id: 'links-create', label: 'Create a link', method: 'POST' }, { id: 'links-retrieve', label: 'Retrieve a link', method: 'GET' }, { id: 'links-list', label: 'List links', method: 'GET' }, { id: 'links-notify', label: 'Send a link', method: 'POST' }, { id: 'links-cancel', label: 'Cancel a link', method: 'POST' }] },
  { group: 'Static QR', items: [{ id: 'static-qr', label: 'Static QR codes', method: 'GET' }, { id: 'static-qr-payments', label: 'QR payments', method: 'GET' }] },
  { group: 'Payments', items: [{ id: 'payments-create', label: 'Create a payment', method: 'POST' }, { id: 'payments-retrieve', label: 'Retrieve a payment', method: 'GET' }, { id: 'payments-list', label: 'List payments', method: 'GET' }, { id: 'refunds-create', label: 'Refund a payment', method: 'POST' }, { id: 'refunds-list', label: 'List refunds', method: 'GET' }] },
  { group: 'Payouts', items: [{ id: 'payouts-create', label: 'Create a payout', method: 'POST' }, { id: 'payouts-retrieve', label: 'Retrieve a payout', method: 'GET' }, { id: 'payouts-list', label: 'List payouts', method: 'GET' }, { id: 'beneficiaries', label: 'Beneficiaries', method: 'POST' }] },
  { group: 'Account', items: [{ id: 'balances', label: 'Balances', method: 'GET' }, { id: 'settlements', label: 'Settlements', method: 'GET' }] },
  { group: 'Webhooks', items: [{ id: 'webhooks', label: 'Events' }, { id: 'webhooks-verify', label: 'Verify signatures' }] },
];

function useActiveSection() {
  const [active, setActive] = useState('introduction');
  useEffect(() => {
    let frame = 0;
    // The current section is the last one whose heading has passed just under the sticky header.
    const update = () => {
      frame = 0;
      const els = [...document.querySelectorAll<HTMLElement>('[data-doc-section]')];
      // A linked section near the top wins (the last sections can't scroll all the way up).
      const linked = location.hash ? document.getElementById(location.hash.slice(1)) : null;
      const linkedTop = linked?.hasAttribute('data-doc-section') ? linked.getBoundingClientRect().top : null;
      const current = linkedTop !== null && linkedTop >= 0 && linkedTop < window.innerHeight / 2 ? linked! : (els.filter((e) => e.getBoundingClientRect().top <= 120).at(-1) ?? els[0]);
      if (current) setActive(current.id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // Capture: in the dashboard the scrolling element is the app's main panel, not the window.
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('hashchange', onScroll);
    onScroll();
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('hashchange', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return active;
}

function Sidebar({ active }: { active: string }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())) })).filter((g) => g.items.length), [q]);
  return (
    <nav aria-label="Documentation" className="space-y-5">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search docs" className="h-9 pl-8" aria-label="Search docs" />
      </div>
      {groups.map((g) => (
        <div key={g.group}>
          <p className="text-foreground mb-1.5 px-2 text-xs font-semibold">{g.group}</p>
          <ul className="space-y-0.5">
            {g.items.map((i) => (
              <li key={i.id}>
                <a href={`#${i.id}`} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors', active === i.id ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                  <span className="min-w-0 flex-1 truncate">{i.label}</span>
                  {i.method && <span className={cn('rounded px-1 font-mono text-[9px] font-bold', METHOD_CLS[i.method])}>{i.method}</span>}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

// ---- Example objects ------------------------------------------------------------------------------

const LINK = {
  id: 'cs_01JC8ZJ4K5M6N7P8Q9R0S1T2V3',
  object: 'payment_link',
  reference: 'INV-204',
  amount: '1499.00',
  currency: 'INR',
  description: 'Invoice INV-204',
  status: 'OPEN',
  url: 'https://pay.example.com/checkout/Xk2…',
  customer: { name: 'Asha Rao', email: 'asha@example.com', mobile: '9876543210' },
  payment_id: null,
  payment: null,
  notified_at: '2026-10-08T11:00:02.000Z',
  expires_at: '2026-10-15T11:00:00.000Z',
  paid_at: null,
  created_at: '2026-10-08T11:00:00.000Z',
};

const PAYMENT = {
  payment_id: 'pay_01JC8Z5XG7Q2H4K6M8P0R2T4V6',
  merchant_order_id: 'ORD-1001',
  checkout_session_id: null,
  amount: '1000.00',
  currency: 'INR',
  fee: '1.80',
  tax: '0.32',
  commission: '0.00',
  net_amount: '997.88',
  refunded_amount: '0.00',
  status: 'PENDING',
  method: 'UPI_QR',
  qr: 'upi://pay?pa=merchant@bank&pn=Sharma%20Electronics&am=1000.00&tr=pay_01JC8Z…&cu=INR',
  upi_intent: 'upi://pay?pa=merchant@bank&…',
  payment_link: null,
  expires_at: '2026-10-08T10:15:00.000Z',
  utr: null,
  customer: { name: 'Asha Rao', mobile: '98XXXXX210', email: 'asha@example.com' },
  description: 'Order 1001',
  metadata: { cart_id: 'c_42' },
  created_at: '2026-10-08T10:00:00.000Z',
};
const SESSION = {
  id: 'cs_01JC8Z9A1B2C3D4E5F6G7H8J9K',
  object: 'checkout_session',
  merchant_order_id: 'ORD-1042',
  amount: '2499.00',
  currency: 'INR',
  description: '2 × Blue kurta',
  status: 'OPEN',
  url: 'https://pay.example.com/checkout/Qm9vbGVhbiB0b2tlbiBzYW1wbGUgdmFsdWUx',
  return_url: 'https://shop.example.com/orders/1042',
  customer: { name: 'Asha Rao', email: 'asha@example.com', mobile: '9876543210' },
  payment_id: null,
  payment: null,
  attempts: 0,
  metadata: { cart_id: 'c_42' },
  expires_at: '2026-10-08T10:30:00.000Z',
  paid_at: null,
  created_at: '2026-10-08T10:00:00.000Z',
};
const PAYOUT = {
  payout_id: 'pout_01JC8ZB2C3D4E5F6G7H8J9K0M1',
  merchant_order_id: 'PO-7731',
  amount: '15000.00',
  fee: '5.00',
  tax: '0.90',
  commission: '0.00',
  total_debit: '15005.90',
  currency: 'INR',
  mode: 'IMPS',
  purpose: 'VENDOR_PAYMENT',
  status: 'QUEUED',
  beneficiary: { beneficiary_id: 'ben_01JC8ZC…', name: 'ABC Vendor', account_number_masked: 'XXXXXXXXXX7890', ifsc: 'HDFC0001234' },
  approvals_required: 0,
  utr: null,
  created_at: '2026-10-08T10:00:00.000Z',
};

// ---- The page -------------------------------------------------------------------------------------

export function ApiReference() {
  // One choice for every sample on the page (kept for this visit only).
  const [lang, setLang] = useState<Lang>('node');
  const active = useActiveSection();
  const brand = useBrand();
  const base = API_URL.replace(/\/$/, '');
  const name = brand.short_name;
  const origin = useWebOrigin();

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <div className="grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <div className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto pr-2 pb-8">
            <Sidebar active={active} />
          </div>
        </aside>
        <div className="min-w-0">
          <Section
            id="introduction"
            title={`${name} API`}
            aside={<CodePanel title="Base URL" single={{ label: 'HTTPS', code: `${base}/v1` }} />}
          >
            <p>
              The {name} API lets your server collect payments (UPI, cards, netbanking, wallets), send payouts, and follow balances and settlements. It is a REST API: resources have predictable URLs, requests and responses are JSON, and every
              change is reported to your server by signed webhooks.
            </p>
            <Table
              head={['Convention', 'Details']}
              rows={[
                ['Amounts', <span key="a">Rupee <strong>strings</strong> with up to two decimals: <code>&quot;1000.00&quot;</code>. JSON numbers are rejected, so floating-point rounding can never change an amount.</span>],
                ['Timestamps', 'ISO-8601 in UTC, e.g. 2026-10-08T10:00:00.000Z'],
                ['IDs', <span key="i">Prefixed: <code>pay_</code> payment, <code>cs_</code> checkout, <code>pout_</code> payout, <code>rfnd_</code> refund, <code>ben_</code> beneficiary, <code>evt_</code> event</span>],
                ['Envelope', <span key="e">Success: <code>{'{ "success": true, "data": … }'}</code>. Errors: <code>{'{ "success": false, "error": { … } }'}</code></span>],
                ['Environments', <span key="v">Test keys (<code>pk_test_</code>) work against the sandbox; live keys (<code>pk_live_</code>) move real money. Data never crosses between them.</span>],
              ]}
            />
          </Section>

          <Section
            id="quickstart"
            title="Quickstart"
            aside={<CodePanel title="Your first checkout" samples={call('POST', '/v1/checkout/sessions', { merchant_order_id: 'ORD-1042', amount: '2499.00', description: '2 × Blue kurta', return_url: 'https://shop.example.com/orders/1042' }, 'session')} />}
          >
            <ol className="space-y-3">
              {[
                ['Create an API key', 'Developers → API keys. Copy the key id and the secret (shown once) into your server’s environment as PAY2ALL_KEY and PAY2ALL_SECRET.'],
                ['Add your website', 'Developers → Websites. Checkout returns customers only to approved websites.'],
                ['Create a checkout session', 'Send the order to POST /v1/checkout/sessions and redirect the customer to the url you get back.'],
                ['Confirm on your server', 'Listen for the payment.success webhook (or call GET /v1/checkout/sessions/:id) before you ship the order.'],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-3">
                  <span className="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">{i + 1}</span>
                  <span>
                    <strong>{t}.</strong> {d}
                  </span>
                </li>
              ))}
            </ol>
          </Section>

          <Section id="authentication" title="Authentication" aside={<CodePanel title="Signing helper" samples={helpers(base)} />}>
            <p>Every request is signed with your API secret using HMAC-SHA256. The secret itself is never sent, and a captured request can’t be replayed: each carries a fresh nonce and a timestamp.</p>
            <Table
              head={['Header', 'Value']}
              rows={[
                [<code key="1">X-Pay2All-Key</code>, 'Your public key id (pk_test_… / pk_live_…)'],
                [<code key="2">X-Pay2All-Timestamp</code>, 'Unix time in seconds; within ±5 minutes of our clock'],
                [<code key="3">X-Pay2All-Nonce</code>, '16–64 characters [A-Za-z0-9_-], new for every request (a UUID works)'],
                [<code key="4">X-Pay2All-Signature</code>, <span key="s"><code>v1=</code> + hex HMAC-SHA256(secret, <code>{'<timestamp>.<nonce>.<METHOD>.<path with query>.<sha256 hex of the raw body>'}</code>)</span>],
                [<code key="5">Idempotency-Key</code>, 'Required on every POST that creates money movement (see Idempotency)'],
              ]}
            />
            <Callout tone="warn">
              <p>
                Sign the <strong>exact bytes</strong> you send. GET requests sign the SHA-256 of an empty string. Keep the secret on your server only — never in a browser or a mobile app.
              </p>
            </Callout>
            <p>Authentication failures always answer <code>401</code> without saying which check failed. Lock keys to your servers’ IPs under Developers → IP whitelist.</p>
          </Section>

          <Section id="idempotency" title="Idempotency" aside={<CodePanel title="Safe retry" samples={call('POST', '/v1/payments', { merchant_order_id: 'ORD-1001', amount: '1000.00', method: 'UPI' }, 'payment')} />}>
            <p>
              Network failures happen. Send an <code>Idempotency-Key</code> header (any unique string up to 64 characters) on <code>POST /v1/payments</code>, <code>/v1/payouts</code>, <code>/v1/checkout/sessions</code> and refunds. Retrying with the same
              key returns the original response — with <code>Idempotent-Replayed: true</code> — instead of creating a second payment.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Keys are remembered for 24 hours.</li>
              <li>The same key with a different body returns <code>409 IDEMPOTENCY_CONFLICT</code>.</li>
              <li>A request still in progress returns <code>409 IDEMPOTENCY_IN_PROGRESS</code>; retry shortly.</li>
              <li>Independently, <code>merchant_order_id</code> is unique per account, so the same order can never be charged twice.</li>
            </ul>
          </Section>

          <Section
            id="errors"
            title="Errors"
            aside={<Json title="Error response" value={{ success: false, error: { code: 'INVALID_REQUEST', message: 'Request validation failed', details: [{ path: 'amount', message: 'Amount must be a positive decimal number like 1000.00' }], request_id: 'req_01JC8ZD4E5F6G7H8J9K0M1N2P3' } }} />}
          >
            <p>
              Errors use conventional HTTP status codes and a stable machine-readable <code>code</code>. Field-level problems come in <code>details</code>. Quote the <code>request_id</code> when you contact support.
            </p>
            <Table
              head={['HTTP', 'Code', 'Meaning']}
              rows={[
                ['400', 'INVALID_REQUEST', 'A parameter is missing or invalid (see details)'],
                ['401', 'UNAUTHORIZED · INVALID_SIGNATURE · REQUEST_EXPIRED', 'Authentication failed'],
                ['403', 'FORBIDDEN · IP_NOT_ALLOWED', 'The key lacks the permission, or the IP isn’t allowed'],
                ['403', 'MERCHANT_INACTIVE · KYC_NOT_APPROVED · PAYIN_DISABLED · PAYOUT_DISABLED', 'Your account can’t do this yet'],
                ['403', 'RISK_BLOCKED', 'Declined by risk controls'],
                ['404', 'NOT_FOUND · TRANSACTION_NOT_FOUND', 'No such resource in your account'],
                ['409', 'DUPLICATE_ORDER · IDEMPOTENCY_CONFLICT · INVALID_STATE_TRANSITION', 'Conflicts with an existing order or state'],
                ['422', 'INSUFFICIENT_BALANCE · LIMIT_EXCEEDED · REFUND_NOT_ALLOWED · BENEFICIARY_NOT_VERIFIED', 'A business rule prevented it'],
                ['429', 'RATE_LIMITED', 'Slow down; honour Retry-After'],
                ['5xx', 'INTERNAL_ERROR · SERVICE_UNAVAILABLE · PROVIDER_UNAVAILABLE', 'Our side or the bank; safe to retry with the same Idempotency-Key'],
              ].map(([h, c, m]) => [<span key="h" className="font-mono">{h}</span>, <code key="c" className="text-xs">{c}</code>, m])}
            />
          </Section>

          <Section id="pagination" title="Pagination" aside={<Json title="List response" value={{ success: true, data: ['…'], meta: { limit: 25, has_more: true, next_cursor: 'eyJjIjoiMjAyNi0xMC0wOFQxMDowMDowMFoiLCJpIjoicGF5XzAxSkM4WiJ9' } }} />}>
            <p>
              List endpoints return newest first and use cursors. Pass <code>limit</code> (1–100, default 25). When <code>meta.has_more</code> is true, request the next page with <code>cursor=meta.next_cursor</code>. Cursors are stable while new
              records arrive.
            </p>
          </Section>

          <Section id="rate-limits" title="Rate limits">
            <p>
              Each key may make <strong>600 requests per minute</strong>. Every response carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and <code>RateLimit-Reset</code>. Over the limit you get <code>429</code> with{' '}
              <code>Retry-After</code> seconds. Prefer webhooks to polling.
            </p>
          </Section>

          <Section id="testing" title="Testing">
            <p>Test keys use the sandbox: no real money moves, and outcomes are decided by the paise of the amount so you can rehearse every path.</p>
            <Table
              head={['Amount ends in', 'Payments (UPI)', 'Payouts']}
              rows={[
                ['.00 (anything else)', 'Succeeds after a few seconds', 'Succeeds after a few seconds'],
                ['.13', 'Fails', 'Rejected by the bank before sending'],
                ['.17', '—', 'Accepted, then fails (funds released)'],
                ['.50', 'Stays pending (then expires)', 'Stays pending'],
                ['.88', '—', 'Succeeds, then is returned by the bank'],
              ].map((r) => r.map((c, i) => (i === 0 ? <code key={i}>{c}</code> : c)))}
            />
            <p>
              In test mode you can also finish a payment instantly: <code>POST /v1/sandbox/payments/{'{payment_id}'}/complete</code> with <code>{'{ "outcome": "SUCCESS" }'}</code> (or <code>FAILED</code>), and the same for payouts. Webhooks
              are sent exactly as in live mode.
            </p>
          </Section>

          <Section
            id="checkout"
            title="How checkout works"
            aside={
              <div className="space-y-3 rounded-xl border p-5">
                {[
                  ['Your server', 'POST /v1/checkout/sessions → url'],
                  ['Customer', 'Pays on the hosted page — UPI QR / app, or cards, netbanking & wallets'],
                  [name, 'Confirms with the bank; sends payment.success'],
                  ['Customer', 'Returns to your return_url with the outcome'],
                  ['Your server', 'Verifies, then fulfils the order'],
                ].map(([who, what], i) => (
                  <div key={i} className="flex gap-3">
                    <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold">{i + 1}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{who}</p>
                      <p className="text-muted-foreground text-sm">{what}</p>
                    </div>
                  </div>
                ))}
              </div>
            }
          >
            <p>
              Hosted checkout is the fastest way to accept payments. You create a <strong>checkout session</strong> for an order and send the customer to its <code>url</code>. They pay on a secure page by UPI or through our card gateways; you never
              handle card data, so your PCI scope stays minimal.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>The customer can retry with another method; every attempt is a payment with <code>merchant_order_id</code> <code>{'<your order>#<n>'}</code> and <code>checkout_session_id</code> set.</li>
              <li>The first successful attempt pays the session. A session can’t be paid twice.</li>
              <li><code>return_url</code> must be on one of your approved websites (Developers → Websites).</li>
            </ul>
          </Section>

          <Endpoint
            id="checkout-create"
            method="POST"
            path="/v1/checkout/sessions"
            title="Create a checkout session"
            body={{ merchant_order_id: 'ORD-1042', amount: '2499.00', description: '2 × Blue kurta', customer: { name: 'Asha Rao', email: 'asha@example.com', mobile: '9876543210' }, return_url: 'https://shop.example.com/orders/1042', expires_in_seconds: 1800, metadata: { cart_id: 'c_42' } }}
            response={{ success: true, data: SESSION }}
            params={[
              { name: 'merchant_order_id', type: 'string', required: true, desc: 'Your order reference: 1–60 of A–Z a–z 0–9 _ - / . :, unique per account.' },
              { name: 'amount', type: 'string', required: true, desc: 'Rupees, e.g. "2499.00" (minimum ₹1.00).' },
              { name: 'return_url', type: 'string', required: true, desc: 'Where the customer lands afterwards. Must be on an approved website.' },
              { name: 'description', type: 'string', desc: 'Shown to the customer (up to 200 characters).' },
              { name: 'customer', type: 'object', desc: 'name, email, mobile — prefill the form so the customer types less.' },
              { name: 'expires_in_seconds', type: 'integer', desc: '300–86400; default 1800 (30 minutes).' },
              { name: 'metadata', type: 'object', desc: 'Up to 20 string key/values, returned on the session and its payments.' },
            ]}
          >
            <p>Creates a hosted payment page for one order. Redirect the customer to <code>url</code>. Requires the <code>Idempotency-Key</code> header.</p>
          </Endpoint>

          <Endpoint id="checkout-retrieve" method="GET" path="/v1/checkout/sessions/:id" title="Retrieve a session" response={{ success: true, data: { ...SESSION, status: 'PAID', payment_id: 'pay_01JC8ZE…', payment: { id: 'pay_01JC8ZE…', status: 'SUCCESS', method: 'UPI_QR', utr: '412345678901' }, attempts: 1, paid_at: '2026-10-08T10:03:12.000Z' } }}>
            <p>
              The source of truth for whether an order is paid. <code>status</code> is <code>OPEN</code>, <code>PAID</code>, <code>EXPIRED</code> or <code>CANCELLED</code>; when paid, <code>payment</code> describes the successful attempt.
            </p>
          </Endpoint>

          <Endpoint
            id="checkout-list"
            method="GET"
            path="/v1/checkout/sessions"
            title="List sessions"
            response={{ success: true, data: [SESSION], meta: { limit: 25, has_more: false, next_cursor: null } }}
            query={[
              { name: 'status', type: 'enum', desc: 'OPEN, PAID, EXPIRED or CANCELLED' },
              { name: 'merchant_order_id', type: 'string', desc: 'Find the session for an order' },
              { name: 'limit / cursor', type: 'pagination', desc: 'See Pagination' },
            ]}
          />

          <Endpoint id="checkout-cancel" method="POST" path="/v1/checkout/sessions/:id/cancel" title="Cancel a session" response={{ success: true, data: { ...SESSION, status: 'CANCELLED' } }}>
            <p>Closes an open, unpaid session — for example when the order is cancelled in your shop. The checkout link stops accepting payments.</p>
          </Endpoint>

          <Section id="checkout-return" title="After payment" aside={<Json title="Return URL" value={{ url: 'https://shop.example.com/orders/1042?checkout_session_id=cs_01JC8Z9A…&merchant_order_id=ORD-1042&status=PAID' }} />}>
            <p>
              When the session ends, the customer returns to your <code>return_url</code> with <code>checkout_session_id</code>, <code>merchant_order_id</code> and <code>status</code> (<code>PAID</code>, <code>EXPIRED</code> or <code>CANCELLED</code>)
              added to the query string.
            </p>
            <Callout tone="warn">
              <p>
                <strong>Never fulfil an order from the return URL alone</strong> — anyone can type it. Confirm with <code>GET /v1/checkout/sessions/:id</code> from your server or with the <code>payment.success</code> webhook.
              </p>
            </Callout>
          </Section>

          <Section id="links" title="Payment links" aside={<Json title="Payment link" value={{ success: true, data: LINK }} />}>
            <p>
              A payment link asks a customer for money without a website: send it by WhatsApp, SMS or email, or show its QR. The customer pays by UPI or card on a secure hosted page and gets a receipt there. Each link is paid at most once.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Statuses: <code>OPEN</code> → <code>PAID</code>, or <code>EXPIRED</code> / <code>CANCELLED</code>. A paid link has a <code>payment</code> with the UTR.
              </li>
              <li>
                You get the usual <code>payment.success</code> webhook; its <code>checkout_session_id</code> is the link&apos;s <code>id</code>.
              </li>
              <li>
                Links you create from the dashboard (Payin → Payment links) and from the API are the same object.
              </li>
            </ul>
          </Section>

          <Endpoint
            id="links-create"
            method="POST"
            path="/v1/payment-links"
            title="Create a payment link"
            body={{ amount: '1499.00', description: 'Invoice INV-204', reference: 'INV-204', customer: { name: 'Asha Rao', email: 'asha@example.com', mobile: '9876543210' }, expires_in_days: 7, notify: { email: true, sms: false } }}
            response={{ success: true, data: LINK }}
            params={[
              { name: 'amount', type: 'string', required: true, desc: 'Rupees, e.g. "1499.00" (minimum ₹1.00).' },
              { name: 'description', type: 'string', required: true, desc: 'What the customer is paying for (2–200 characters). Shown on the page and in messages.' },
              { name: 'reference', type: 'string', desc: 'Your reference, e.g. an invoice number: 1–60 of A–Z a–z 0–9 _ - / . :, unique per account. Generated (PL-…) when omitted.' },
              { name: 'customer', type: 'object', desc: 'name, email, mobile. Needed for the channels you notify on.' },
              { name: 'expires_in_days', type: 'integer', desc: '1–90; default 7.' },
              { name: 'notify', type: 'object', desc: '{ email, sms } — send the link right away. Off by default.' },
              { name: 'metadata', type: 'object', desc: 'Up to 20 string key/values.' },
            ]}
          >
            <p>
              Requires the <code>Idempotency-Key</code> header. A retried request returns the same link and never sends a second message.
            </p>
          </Endpoint>

          <Endpoint id="links-retrieve" method="GET" path="/v1/payment-links/:id" title="Retrieve a link" response={{ success: true, data: { ...LINK, status: 'PAID', payment_id: 'pay_01JC8ZE…', payment: { id: 'pay_01JC8ZE…', status: 'SUCCESS', method: 'UPI_QR', utr: '412345678901' }, paid_at: '2026-10-08T11:20:41.000Z' } }}>
            <p>The source of truth for whether a link is paid.</p>
          </Endpoint>

          <Endpoint
            id="links-list"
            method="GET"
            path="/v1/payment-links"
            title="List links"
            response={{ success: true, data: [LINK], meta: { limit: 25, has_more: false, next_cursor: null } }}
            query={[
              { name: 'status', type: 'enum', desc: 'OPEN, PAID, EXPIRED or CANCELLED' },
              { name: 'reference', type: 'string', desc: 'References starting with this text' },
              { name: 'limit / cursor', type: 'pagination', desc: 'See Pagination' },
            ]}
          />

          <Endpoint id="links-notify" method="POST" path="/v1/payment-links/:id/notify" title="Send a link" body={{ email: true, sms: true }} response={{ success: true, data: { ...LINK, notified_at: '2026-10-08T11:02:00.000Z' } }}>
            <p>Emails and/or texts an open link to the customer on file. At most once a minute per link. SMS in India uses your DLT-approved template.</p>
          </Endpoint>

          <Endpoint id="links-cancel" method="POST" path="/v1/payment-links/:id/cancel" title="Cancel a link" response={{ success: true, data: { ...LINK, status: 'CANCELLED' } }}>
            <p>Stops an unpaid link from accepting payments.</p>
          </Endpoint>

          <Endpoint id="static-qr" method="GET" path="/v1/static-qrs" title="Static QR codes" response={{ success: true, data: [{ id: 'sqr_01JC8ZH…', object: 'static_qr', label: 'Counter 1', status: 'ACTIVE', upi_payload: 'upi://pay?pa=…&pn=Sharma%20Electronics&cu=INR', image_url: null, last_credit_at: '2026-10-08T12:40:00.000Z', today: { count: 18, amount: '7420.00' } }] }}>
            <p>
              Static QR codes are printed once and accept any amount, from any UPI app. Create and close them in the dashboard (Payin → QR codes). Every payment received becomes a normal payment with <code>method: &quot;UPI_STATIC_QR&quot;</code> and <code>static_qr_id</code>, and triggers <code>payment.created</code> and <code>payment.success</code> webhooks.
            </p>
          </Endpoint>

          <Endpoint id="static-qr-payments" method="GET" path="/v1/static-qrs/:id/payments" title="QR payments" response={{ success: true, data: [{ ...PAYMENT, merchant_order_id: 'SQR-pay_NsK1a2b3', method: 'UPI_STATIC_QR', static_qr_id: 'sqr_01JC8ZH…', amount: '250.00', status: 'SUCCESS', utr: '412398765432' }] }}>
            <p>The latest payments received on one QR code, newest first.</p>
          </Endpoint>

          <Section id="checkout-popup" title="Popup checkout (checkout.js)" aside={<CodePanel title="Your checkout page" single={{ label: 'HTML', code: popupSnippet(origin) }} />}>
            <p>
              Keep customers on your page: <code>checkout.js</code> opens the hosted checkout in a secure popup window and tells your page how it ended. Your server still creates the session; the script only displays it.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Call <code>Pay2All.checkout()</code> directly inside a click handler, so the browser allows the popup. If a popup is blocked, the customer is sent to the checkout page instead (the normal redirect flow).
              </li>
              <li>
                <code>onSuccess</code> / <code>onFailure</code> receive <code>{'{ status, checkout_session_id, merchant_order_id, payment_id }'}</code>. The result is posted only to your approved website&apos;s origin.
              </li>
              <li>
                <code>onClose</code> runs when the customer closes the window without a result. Check the order on your server: a payment may still have completed (for example if a bank page cut the link to your window).
              </li>
              <li>
                Your page must not send <code>Cross-Origin-Opener-Policy: same-origin</code> (use <code>same-origin-allow-popups</code>), or the popup can&apos;t report back.
              </li>
            </ul>
            <Callout tone="warn">
              <p>
                Treat the popup&apos;s result as a hint for your UI. Fulfil orders only after <code>GET /v1/checkout/sessions/:id</code> or the <code>payment.success</code> webhook confirms them.
              </p>
            </Callout>
          </Section>

          <Section id="plugins" title="Plugins & SDKs">
            <ul className="divide-y rounded-lg border">
              <li className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  <strong>WooCommerce</strong> — hosted checkout, webhook confirmation, refunds from the order screen.
                </span>
                <a className="text-primary text-sm font-medium hover:underline" href="/downloads/pay2all-woocommerce-1.0.0.zip" download>
                  Download v1.0.0
                </a>
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  <strong>OpenCart 4.0.2+</strong> (beta) — hosted checkout and webhook confirmation.
                </span>
                <a className="text-primary text-sm font-medium hover:underline" href="/downloads/pay2all-opencart-1.0.0.ocmod.zip" download>
                  Download v1.0.0
                </a>
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  <strong>PHP SDK</strong> — one file: signed requests, idempotency keys, webhook verification.
                </span>
                <a className="text-primary text-sm font-medium hover:underline" href="/downloads/pay2all-php-1.0.0.zip" download>
                  Download v1.0.0
                </a>
              </li>
            </ul>
            <p>
              Every plugin needs your store&apos;s address approved under Developers → Websites, an API key, and a webhook endpoint for <code>payment.success</code>. Step-by-step setup is on the Developers → Integrations page of your dashboard.
            </p>
            <Callout>
              <p>
                <strong>Shopify:</strong> Shopify only lets approved payment partners add a checkout payment method, so there is no Pay2All app for Shopify checkout. You can still collect for Shopify orders with a <a href="#links">payment link</a> (for example with a manual payment method).
              </p>
            </Callout>
          </Section>

          <Endpoint
            id="payments-create"
            method="POST"
            path="/v1/payments"
            title="Create a payment"
            body={{ merchant_order_id: 'ORD-1001', amount: '1000.00', method: 'UPI', customer: { name: 'Asha Rao', mobile: '9876543210', email: 'asha@example.com' }, description: 'Order 1001', expires_in_seconds: 900, metadata: { cart_id: 'c_42' } }}
            response={{ success: true, data: PAYMENT }}
            params={[
              { name: 'merchant_order_id', type: 'string', required: true, desc: '1–64 of A–Z a–z 0–9 _ - / . :, unique per account.' },
              { name: 'amount', type: 'string', required: true, desc: 'Rupees, minimum "1.00".' },
              { name: 'method', type: 'enum', desc: 'UPI or UPI_QR (QR + intent, default), UPI_INTENT, or PAYMENT_LINK (hosted gateway page).' },
              { name: 'customer', type: 'object', desc: 'name, mobile, email, vpa' },
              { name: 'description', type: 'string', desc: 'Up to 200 characters' },
              { name: 'expires_in_seconds', type: 'integer', desc: '120–86400; default 900' },
              { name: 'metadata', type: 'object', desc: 'Up to 20 string key/values' },
            ]}
          >
            <p>
              Server-to-server collection when you build your own payment UI: show <code>qr</code> as a QR code, open <code>upi_intent</code> on mobile, or redirect to <code>payment_link</code>. For most shops, <a href="#checkout" className="text-primary hover:underline">hosted checkout</a> is simpler.
            </p>
          </Endpoint>

          <Endpoint id="payments-retrieve" method="GET" path="/v1/payments/:id" title="Retrieve a payment" response={{ success: true, data: { ...PAYMENT, status: 'SUCCESS', utr: '412345678901', payer_vpa: 'asha@okbank', success_at: '2026-10-08T10:01:05.000Z' } }}>
            <p>
              <code>status</code>: <code>CREATED</code> → <code>PENDING</code> → <code>SUCCESS</code> | <code>FAILED</code> | <code>EXPIRED</code>, then <code>SETTLED</code>, <code>PARTIALLY_REFUNDED</code> or <code>REFUNDED</code>. A success after expiry is
              flagged with <code>late_success: true</code>.
            </p>
          </Endpoint>

          <Endpoint
            id="payments-list"
            method="GET"
            path="/v1/payments"
            title="List payments"
            response={{ success: true, data: [PAYMENT], meta: { limit: 25, has_more: false, next_cursor: null } }}
            query={[
              { name: 'status', type: 'csv enum', desc: 'e.g. SUCCESS,REFUNDED' },
              { name: 'method', type: 'csv enum', desc: 'UPI_QR, UPI_INTENT, PAYMENT_LINK' },
              { name: 'merchant_order_id', type: 'string', desc: 'Exact order id' },
              { name: 'utr', type: 'string', desc: 'Bank reference of a successful payment' },
              { name: 'amount_min / amount_max', type: 'string', desc: 'Amount range in rupees' },
              { name: 'created_from / created_to', type: 'ISO date-time', desc: 'Created between' },
              { name: 'limit / cursor', type: 'pagination', desc: 'See Pagination' },
            ]}
          />

          <Endpoint
            id="refunds-create"
            method="POST"
            path="/v1/payments/:id/refunds"
            title="Refund a payment"
            body={{ amount: '250.00', reason: 'Item out of stock', merchant_refund_id: 'RF-1001-1' }}
            response={{ success: true, data: { refund_id: 'rfnd_01JC8ZF…', payment_id: PAYMENT.payment_id, amount: '250.00', status: 'PENDING', merchant_refund_id: 'RF-1001-1', created_at: '2026-10-08T12:00:00.000Z' } }}
            params={[
              { name: 'amount', type: 'string', required: true, desc: 'Up to the refundable balance; partial refunds allowed.' },
              { name: 'reason', type: 'string', desc: 'Up to 300 characters' },
              { name: 'merchant_refund_id', type: 'string', desc: 'Your reference, unique per account' },
            ]}
          >
            <p>Refunds go back to the customer’s original method. The amount is debited from your balance immediately and returned if the refund fails. You’ll get <code>refund.success</code> or <code>refund.failed</code>.</p>
          </Endpoint>

          <Endpoint id="refunds-list" method="GET" path="/v1/refunds" title="List refunds" response={{ success: true, data: [{ refund_id: 'rfnd_01JC8ZF…', payment_id: PAYMENT.payment_id, amount: '250.00', status: 'SUCCESS' }], meta: { limit: 25, has_more: false, next_cursor: null } }} />

          <Endpoint
            id="payouts-create"
            method="POST"
            path="/v1/payouts"
            title="Create a payout"
            body={{ merchant_order_id: 'PO-7731', amount: '15000.00', mode: 'IMPS', purpose: 'VENDOR_PAYMENT', beneficiary: { name: 'ABC Vendor', account_number: '50100123457890', ifsc: 'HDFC0001234' }, narration: 'Invoice 7731' }}
            response={{ success: true, data: PAYOUT }}
            params={[
              { name: 'merchant_order_id', type: 'string', required: true, desc: 'Unique per account' },
              { name: 'amount', type: 'string', required: true, desc: 'Rupees. IMPS/UPI up to ₹5,00,000; RTGS from ₹2,00,000.' },
              { name: 'mode', type: 'enum', required: true, desc: 'IMPS, NEFT, RTGS or UPI' },
              { name: 'beneficiary', type: 'object', required: true, desc: <span>Either <code>{'{ beneficiary_id }'}</code>, or <code>name</code> with <code>account_number</code> + <code>ifsc</code> (bank) or <code>upi_id</code> (UPI). Saved for reuse.</span> },
              { name: 'purpose', type: 'enum', desc: 'CUSTOMER_PAYOUT, VENDOR_PAYMENT (default), REFUND_PAYOUT, SALARY, API_PAYOUT' },
              { name: 'narration', type: 'string', desc: 'Shown on the beneficiary’s statement where the bank supports it' },
            ]}
          >
            <p>
              Reserves <code>total_debit</code> (amount + fee + GST) from your available balance immediately. Payouts above your approval threshold wait for an approver in the dashboard (<code>status: APPROVAL_PENDING</code>). Add funds from
              Accounts → Add funds.
            </p>
          </Endpoint>

          <Endpoint id="payouts-retrieve" method="GET" path="/v1/payouts/:id" title="Retrieve a payout" response={{ success: true, data: { ...PAYOUT, status: 'SUCCESS', utr: '612345678901', processed_at: '2026-10-08T10:00:41.000Z' } }}>
            <p>
              <code>status</code>: <code>QUEUED</code> → <code>PROCESSING</code> → <code>SUCCESS</code> | <code>FAILED</code>; a successful payout can later become <code>REVERSED</code> if the beneficiary bank returns it.
            </p>
          </Endpoint>

          <Endpoint id="payouts-list" method="GET" path="/v1/payouts" title="List payouts" response={{ success: true, data: [PAYOUT], meta: { limit: 25, has_more: false, next_cursor: null } }} />

          <Endpoint
            id="beneficiaries"
            method="POST"
            path="/v1/beneficiaries"
            title="Beneficiaries"
            body={{ name: 'ABC Vendor', type: 'BUSINESS', account_number: '50100123457890', ifsc: 'HDFC0001234' }}
            response={{ success: true, data: { beneficiary_id: 'ben_01JC8ZC…', name: 'ABC Vendor', account_number_masked: 'XXXXXXXXXX7890', ifsc: 'HDFC0001234', verification_status: 'UNVERIFIED' } }}
          >
            <p>
              Save beneficiaries once and pay them by id. <code>GET /v1/beneficiaries</code> lists them; <code>POST /v1/beneficiaries/:id/verify</code> runs a penny-drop / name check (required above ₹25,000). Full account numbers are never returned.
            </p>
          </Endpoint>

          <Endpoint id="balances" method="GET" path="/v1/ledger/balances" title="Balances" response={{ success: true, data: { merchant_id: 'org_01JC…', currency: 'INR', available: '84210.50', unsettled: '12500.00', pending: '0.00', reserved: '15005.90', lien: '0.00', settled_to_date: '1250000.00', as_of: '2026-10-08T10:05:00.000Z' } }}>
            <p>
              <strong>available</strong> can be paid out; <strong>unsettled</strong> is collected and awaiting settlement; <strong>reserved</strong> is held for payouts in flight. Every figure comes from a double-entry ledger.
            </p>
          </Endpoint>

          <Endpoint id="settlements" method="GET" path="/v1/settlements" title="Settlements" response={{ success: true, data: [{ settlement_id: 'stl_01JC…', settlement_date: '2026-10-08', gross: '125000.00', fees: '225.00', net: '124775.00', status: 'PROCESSED', utr: 'HDFCN52026100812345678' }], meta: { limit: 25, has_more: false, next_cursor: null } }}>
            <p>Settlements move your collected funds to your bank account on your schedule. <code>GET /v1/settlements/:id</code> includes the payments it covers.</p>
          </Endpoint>

          <Section
            id="webhooks"
            title="Webhook events"
            aside={<Json title="Delivery" value={{ id: 'evt_01JC8ZG…', type: 'payment.success', created_at: '2026-10-08T10:01:05.000Z', data: { ...PAYMENT, status: 'SUCCESS', utr: '412345678901' } }} />}
          >
            <p>
              Add HTTPS endpoints under Developers → Webhooks. We <code>POST</code> each event as JSON with headers <code>Pay2All-Event-Id</code>, <code>Pay2All-Event-Type</code> and <code>Pay2All-Signature</code>. Reply <strong>2xx within 10 seconds</strong>;
              failures are retried over about two days (1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, 24 h) and can be replayed from the log.
            </p>
            <Table
              head={['Event', 'When']}
              rows={[
                ['payment.pending', 'A QR / intent / payment page is live'],
                ['payment.success', 'The bank confirmed the payment — fulfil the order'],
                ['payment.failed', 'Failed or expired'],
                ['refund.success / refund.failed', 'Refund outcome'],
                ['payout.queued / payout.processing', 'Approved / accepted by the bank'],
                ['payout.success', 'Credited (utr included)'],
                ['payout.failed / payout.rejected / payout.reversed', 'Not paid or returned; funds back in your balance'],
              ].map(([e, w]) => [<code key="e">{e}</code>, w])}
            />
            <Callout>
              <p>Delivery is at least once and may be out of order. Make handlers idempotent on the event <code>id</code> and trust the <code>status</code> in the payload.</p>
            </Callout>
          </Section>

          <Section id="webhooks-verify" title="Verify signatures" aside={<CodePanel title="Verify" samples={WEBHOOK_VERIFY} />}>
            <p>
              <code>Pay2All-Signature: t=1791297600,v1=5f2c…</code>. Compute HMAC-SHA256 of <code>{'<t>.<raw body>'}</code> with your endpoint’s signing secret and compare it, in constant time, with each <code>v1</code> value. Reject
              timestamps more than five minutes old.
            </p>
            <Callout tone="ok">
              <p>During a secret rotation the header carries two <code>v1</code> values for 24 hours — accept either.</p>
            </Callout>
            <a href="#introduction" className="text-primary inline-flex items-center gap-1 text-sm font-medium hover:underline">
              Back to top <ArrowRight className="size-3.5 -rotate-90" />
            </a>
          </Section>

          <p className="text-muted-foreground flex items-center gap-2 pt-6 text-xs">
            <CheckCircle2 className="size-3.5" /> API version v1. New fields and event types may be added without notice; existing fields and error codes never change meaning.
          </p>
        </div>
      </div>
    </LangContext.Provider>
  );
}
