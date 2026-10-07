# Load testing

k6 scripts live in `load/k6/`. They call the **public signed API** exactly as a merchant integration would: HMAC signature, fresh nonce, `Idempotency-Key`. Results from the first run are in [RESULTS-2026-10-07.md](RESULTS-2026-10-07.md).

## Running

```bash
# 1. Fixtures: N load-test merchants with high limits, ₹10 crore each, a verified beneficiary and an
#    API key. Credentials go to load/k6/.loadtest.env (gitignored, mode 600) and are never printed.
pnpm --filter @pay2all/api build
node apps/api/dist/scripts/seed-loadtest.js 4          # development databases only (refuses in production)

# 2. Start the API (and jobs + worker for a realistic background load), e.g. on port 4100:
PORT=4100 LOG_LEVEL=warn node apps/api/dist/main.js

# 3. Run k6 (offline image; no remote modules):
cd load/k6
docker run --rm -v "$PWD":/scripts -w /scripts --env-file .loadtest.env \
  -e BASE_URLS=http://host.docker.internal:4100 -e DURATION=2m \
  -e PAYIN_RATE=100 -e PAYOUT_RATE=30 -e READ_RATE=50 \
  --add-host host.docker.internal:host-gateway grafana/k6:1.4.2 run --summary-export results/run.json mixed.js
```

## Workload: `mixed.js`

Open model (`constant-arrival-rate`): requests arrive at the configured rate whether or not earlier ones finished, so saturation shows up as latency and dropped iterations instead of being hidden by a slower client.

| Scenario | Requests | Pass criteria |
| --- | --- | --- |
| `payin_create` | `POST /v1/payments`, ₹100–₹5,000 UPI | p95 < 800 ms, errors < 1% |
| `payout_create` | `POST /v1/payouts`, IMPS to the merchant's verified beneficiary | p95 < 800 ms, errors < 1% |
| `reads` | `GET /v1/payments?limit=25`, then `GET /v1/payments/:id` | p95 < 300 ms, errors < 1% |

Further rules: zero dropped iterations. Several API nodes can be targeted round-robin with `BASE_URLS=a,b,c`.

## Caveats when reading results

- **Provider calls are simulated.** The mock providers add `LOADTEST_PROVIDER_LATENCY_MS` (default 80 ms). Real provider latency (often 200–1500 ms) adds directly to payin create time, but holds no database resources while it runs.
- **Payouts serialise per merchant** on the merchant's AVAILABLE balance row (by design: the reservation must be exact). Payout throughput therefore scales with the number of active merchants, not with nodes.
- **Same machine for everything.** The load generator, all processes and the databases share one machine, and Docker Desktop's host networking limits new connections; under overload k6 reports `dial: i/o timeout`. Numbers here are a lower bound on what separate hosts would achieve, **not** a capacity claim for production.
