# Pay2All Payments

Multi-tenant payin/payout platform by **Pay2All Services Pvt. Ltd.**: collections, payouts, settlements, a double-entry ledger, reconciliation, compliance and risk, built as an API-first modular monolith.

> Status: **Phase 1 (Foundation) complete.** See [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start

Requires Node ≥ 22.12, pnpm 10 and Docker.

```bash
cp .env.example .env                       # then replace every secret (openssl rand -base64 48 / 32)
docker compose up -d                       # Postgres, Redis, Kafka, S3 (SeaweedFS), Mailpit
pnpm install
pnpm prisma:migrate                        # applies migrations to the dev DB
SEED_PASSWORD='Choose-A-Dev-Password' pnpm db:seed
pnpm dev                                   # API :4000, web :3000, worker health :4001
pnpm dev:jobs                              # payin/payout jobs + payout Kafka fast path (separate terminal)
```

| Service | URL |
| --- | --- |
| Web dashboard | http://localhost:3000 |
| API | http://localhost:4000 |
| Swagger / OpenAPI | http://localhost:4000/docs (`/docs/openapi.json`) |
| Mailpit (reset/invite emails) | http://localhost:58025 |

Docker host ports default to non-standard values (Postgres `55432`, Redis `56379`, Kafka `59092`, S3 `58333`) to avoid clashing with other local stacks. Override them with `*_HOST_PORT` env vars.

The worker (part of `pnpm dev`) relays the outbox to Kafka, delivers merchant webhooks and sends email (view it in Mailpit). To deliver webhooks to a receiver on your own machine, set `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (development only).

Platform and reseller users must enroll TOTP on first sign-in (`AUTH_ENFORCE_MFA=true`). Seeded merchant owners (e.g. `owner@sharma-electronics.local`) can sign in directly.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | All packages through Turborepo |
| `pnpm test:integration` | API integration tests (uses `pay2all_test` DB + Redis DB 1, rebuilt per run) |
| `pnpm prisma:validate` / `pnpm prisma:migrate` | Schema validation / dev migrations |
| `pnpm build` | Production builds |
| `npm run deploy` | Deploy `main` to the server in `deploy.env` (https://py.2all.co.in), see [Deployment](docs/DEPLOYMENT.md) |

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE.md) · [Security](docs/SECURITY.md) · [Ledger](docs/LEDGER.md) · [Payin flow](docs/PAYIN_FLOW.md) · [Payout flow](docs/PAYOUT_FLOW.md) · [Deployment](docs/DEPLOYMENT.md) · [Roadmap](docs/ROADMAP.md)

## Regulatory note

This software does not assume Pay2All holds any RBI licence. Regulated processing and settlement are modelled as performed through partner banks, PSPs or authorised payment aggregators, as configured.
