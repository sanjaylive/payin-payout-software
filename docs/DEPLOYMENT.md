# Deployment

`npm run deploy` ships the committed `HEAD` of `main` to one Linux server over SSH, then runs the whole stack there with Docker Compose behind Caddy, with automatic HTTPS:

- **Domain:** `https://py.2all.co.in`
- **Routing:** the dashboard and checkout are served at `/`; the API is under `/v1` on the same origin.

## 1. One-time setup

### Server
- Any Linux VPS (Ubuntu 24.04 or Debian 12 is fine).
- At least 4 vCPU, 8 GB RAM and 80 GB SSD. The three Kafka brokers alone use about 2 GB.
- Docker Engine with the compose plugin (`curl -fsSL https://get.docker.com | sh`).
- A deploy user in the `docker` group, signed in with an SSH key; password SSH turned off.
- Firewall: only 22, 80 and 443 open (80 and 443 over TCP; 443 over UDP for HTTP/3).

### DNS
An `A` record (and `AAAA` if the server has IPv6) for `py.2all.co.in` pointing at the server. Caddy obtains the certificate on the first request, which needs DNS to resolve and port 80 to be reachable.

### Your machine
Copy `infra/deploy/deploy.env.example` to `deploy.env` at the repo root. It is git-ignored. Set `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`, `DEPLOY_DIR` (default `/opt/pay2all`) and `DOMAIN`.

## 2. First deploy

1. **Run `npm run deploy`.** It runs the checks, uploads the code, and then stops. Because there is no environment file on the server yet, it creates `/opt/pay2all/.env.production` **on the server**, mode 600, with fresh random secrets. The secrets never exist on your machine or in git.
2. **Edit that file on the server.** Replace every `CHANGE_ME`:

   | Key | Value |
   | --- | --- |
   | `ACME_EMAIL` | Address for Let's Encrypt notices |
   | `SMTP_URL` | Outgoing mail, for example Amazon SES SMTP: `smtps://USER:PASS@email-smtp.ap-south-1.amazonaws.com:465` |
   | `BOOTSTRAP_ADMIN_EMAIL` | The first super admin's email address |

3. **Run `npm run deploy` again.** The migrate step prints the **first super admin's password once**.
4. **Sign in at `https://py.2all.co.in/login`.** You will be required to set up two-factor (a passkey or authenticator app). Then change the password.
5. **In Settings:**
   - **File Storage:** choose Local disk (the `/data/storage` volume) or your S3 bucket. KYC uploads need one of these.
   - **Payment Gateways:** connect real gateways. The sandbox gateways are **not** created in production.
   - **API Vendors:** SMS, WhatsApp and email vendors.
   - **Branding.**
6. **`API_ENVIRONMENT=TEST`** issues `pk_test_` keys. Change it to `LIVE` in the env file, then redeploy, only once real gateways are tested end to end.

## 3. Every deploy

`npm run deploy` does the following, and stops at the first failure:

1. Refuses to run with uncommitted changes, or from a branch other than `main` (override with `DEPLOY_ALLOW_BRANCH`).
2. Runs `pnpm typecheck`, `pnpm lint` and `pnpm test`. Use `--skip-checks` only in an emergency: `npm run deploy -- --skip-checks`.
3. Uploads the code with `git archive` to `releases/<commit>`.
4. Checks the env file: no `CHANGE_ME` left, and `DOMAIN` matches.
5. Builds the image `pay2all-app:<commit>` **on the server**, so it matches the server's CPU architecture and nothing large crosses the network.
6. Starts Postgres, Redis and Kafka, waiting until they are healthy.
7. Runs `prisma migrate deploy`, then `db:bootstrap` (see §4).
8. Starts the API and waits for it to be healthy, then starts jobs, worker, web and Caddy.
9. Points `current` at the new release and checks that `https://<domain>/v1/brand` and `/login` respond.
10. Keeps the last 5 releases and their images.

**Rollback:** `npm run deploy -- --rollback <commit>` restarts a previous release's image. Database migrations are **not** reversed. Migrations are additive, so the previous code normally runs on the newer schema, but check the release notes first.

**Logs on the server:**
```
cd /opt/pay2all/current && docker compose -p pay2all -f infra/deploy/compose.yml logs -f --tail 100 api
```

## 4. Bootstrap (`db:bootstrap`)

The bootstrap is safe to run on every deploy and changes nothing that already exists. It:
- syncs permissions and system roles;
- creates the platform organization if there is none;
- adds the default payout approval tiers and the starter risk rules, which start in MONITOR mode;
- creates a first `SUPER_ADMIN` from `BOOTSTRAP_ADMIN_EMAIL`, **only while no active super admin exists**. The password is random and printed once.

It never creates demo users, merchants, gateways or vendors. The demo seed (`db:seed`) refuses to run in production.

## 5. What runs

| Service | Notes |
| --- | --- |
| `caddy` | The only service with published ports (80, 443). HTTPS with HSTS. `/v1/*` goes to the API and everything else to web. `/health/*` is blocked publicly |
| `api` | NestJS on 4000. `TRUST_PROXY_HOPS=1`, so client IPs come from Caddy |
| `jobs` | Payin/payout pollers, settlements, invoices and reconciliation |
| `worker` | Outbox and Kafka consumers, webhooks, notifications, provider health |
| `web` | Next.js on 3000. The bundle is built for `https://<domain>` |
| `postgres`, `redis` | Private network only. Redis requires a password |
| `kafka-1..3` | KRaft cluster. Replication factor 3, as the worker requires in production |
| `migrate` | Runs once per deploy |

Volumes: `postgres-data`, `redis-data`, `kafka-1..3`, `storage` (local-disk files), and `caddy-data` (certificates).

## 6. Before taking real money

- **Backups.** Nothing is backed up yet. At minimum, run a nightly `pg_dump` to off-server storage and back up the `storage` volume. Better: a managed Postgres with point-in-time recovery, configured through `DATABASE_URL`.
- **Single server.** The three Kafka brokers protect against one broker crashing, not against losing the server. For high availability, move Postgres, Redis and Kafka to managed services and run two or more app servers behind a load balancer.
- **Monitoring.** Set `SENTRY_DSN`. Prometheus metrics stay on 127.0.0.1 inside each container; scrape them over a private network if you add Prometheus.
- **Secrets.** `ENCRYPTION_KEY` protects stored gateway and vendor credentials. Losing it makes them unreadable, so keep an offline copy of the env file somewhere safe.
- **Reseller custom domains** (docs/BRANDING.md §5) each need a Caddy site block, or an nginx vhost in nginx mode. Caddy can obtain their certificates automatically too.

## 7. Sharing a server with an existing nginx (`DEPLOY_PROXY=nginx`)

Use this mode when nginx on the server already serves other sites on ports 80/443. It is how `py.2all.co.in` runs on the shared GoDaddy VPS (148.72.246.21).

- **Ports:** Caddy is not started. The API and web publish on loopback only (`127.0.0.1:4500` and `:3500`), through `infra/deploy/compose.nginx.yml`.
- **Vhost:** the deploy installs `/etc/nginx/sites-available/pay2all-<domain>.conf` from `infra/deploy/nginx/site.conf`, using `install-site.sh`. That script runs `nginx -t` on the **whole** config before reloading. If the test fails, it restores the previous vhost, so a bad Pay2All vhost cannot take down the other sites. An unchanged vhost is left alone.
- **Certificate:** on the first deploy, a temporary HTTP-only vhost answers the ACME challenge. `certbot certonly --webroot` then issues the certificate with `ACME_EMAIL`, which agrees to the Let's Encrypt terms. Certbot never edits the vhost, and renewals reload nginx through a deploy hook.
- **Requirements:** the deploy user needs passwordless `sudo` for nginx, certbot and creating `DEPLOY_DIR`.
- **Memory guard:** before building, the deploy checks that the server has at least `DEPLOY_MIN_AVAILABLE_MB` available (default 3000 MB). Memory held by the running Pay2All release counts as available, since the deploy replaces it. If there isn't enough, it stops rather than starve the other sites.
  - Each service also has a `mem_limit` cap. Typical use is about 2–2.5 GB: three Kafka brokers at about 400 MB each, plus Postgres, Redis and four Node processes.
  - The image build compiles one package at a time with a 1.5 GB Node heap.
  - The shared VPS needs a RAM upgrade to 8 GB before the first deploy.
