// Mixed API workload (docs/perf/README.md). Open model: requests arrive at a fixed rate whether or
// not earlier ones finished, so latency growth shows up instead of being hidden by slower clients.
//   PAYIN_RATE / PAYOUT_RATE / READ_RATE: requests per second for each scenario (0 = off)
//   DURATION: steady-state duration (default 2m)
import { check } from 'k6';
import { loadKeys, orderId, rupees, signedRequest } from './lib/client.js';

const KEYS = loadKeys();
const DURATION = __ENV.DURATION || '2m';
const rate = (name, dflt) => Number(__ENV[name] ?? dflt);

function scenario(exec, ratePerSec) {
  return {
    executor: 'constant-arrival-rate',
    exec,
    rate: ratePerSec,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: Math.max(10, ratePerSec),
    maxVUs: Math.max(50, ratePerSec * 4),
  };
}

const scenarios = {};
if (rate('PAYIN_RATE', 60) > 0) scenarios.payin_create = scenario('payinCreate', rate('PAYIN_RATE', 60));
if (rate('PAYOUT_RATE', 20) > 0) scenarios.payout_create = scenario('payoutCreate', rate('PAYOUT_RATE', 20));
if (rate('READ_RATE', 20) > 0) scenarios.reads = scenario('reads', rate('READ_RATE', 20));

export const options = {
  scenarios,
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    'http_req_failed{scenario:payin_create}': ['rate<0.01'],
    'http_req_failed{scenario:payout_create}': ['rate<0.01'],
    'http_req_failed{scenario:reads}': ['rate<0.01'],
    'http_req_duration{scenario:payin_create}': ['p(95)<800'],
    'http_req_duration{scenario:payout_create}': ['p(95)<800'],
    'http_req_duration{scenario:reads}': ['p(95)<300'],
    dropped_iterations: ['count<1'],
  },
};

const pick = () => KEYS[Math.floor(Math.random() * KEYS.length)];

export function payinCreate() {
  const cred = pick();
  // Whole rupees: the mock provider treats paise .13/.50 as scripted outcomes.
  const res = signedRequest(cred, 'POST', '/v1/payments', { merchant_order_id: orderId('lt'), amount: rupees(10_000, 500_000).replace(/\.\d\d$/, '.00'), method: 'UPI' }, { name: 'POST /v1/payments' });
  check(res, { 'payin 201': (r) => r.status === 201 });
}

export function payoutCreate() {
  const cred = pick();
  const res = signedRequest(
    cred,
    'POST',
    '/v1/payouts',
    { merchant_order_id: orderId('lto'), amount: rupees(10_000, 100_000).replace(/\.\d\d$/, '.00'), mode: 'IMPS', purpose: 'VENDOR_PAYMENT', beneficiary: { beneficiary_id: cred.beneficiary_id } },
    { name: 'POST /v1/payouts' },
  );
  check(res, { 'payout 202': (r) => r.status === 202 });
}

export function reads() {
  const cred = pick();
  const list = signedRequest(cred, 'GET', '/v1/payments?limit=25', undefined, { name: 'GET /v1/payments' });
  check(list, { 'list 200': (r) => r.status === 200 });
  const first = list.status === 200 ? list.json('data.0.payment_id') : null;
  if (first) check(signedRequest(cred, 'GET', `/v1/payments/${first}`, undefined, { name: 'GET /v1/payments/:id' }), { 'get 200': (r) => r.status === 200 });
}
