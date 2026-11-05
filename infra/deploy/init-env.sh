#!/usr/bin/env bash
# Creates the server's .env.production with fresh random secrets. Runs ON THE SERVER (scripts/deploy.sh
# calls it over SSH the first time), so secrets never exist on a laptop or in git.
# Usage: init-env.sh <path> <domain>
set -euo pipefail
OUT=${1:?path}; DOMAIN=${2:?domain}
if [ -e "$OUT" ]; then echo "$OUT already exists; not overwriting." >&2; exit 1; fi
command -v openssl >/dev/null || { echo "openssl is required on the server" >&2; exit 1; }

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 "$1" | tr -d '\n'; }
url64() { openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'; }

PG=$(hex 24); RD=$(hex 24)
umask 077
cat > "$OUT" <<ENV
# Pay2All production environment — generated $(date -u +%Y-%m-%dT%H:%MZ) on this server.
# Keep this file only here (chmod 600). Never copy it into git, chat or tickets.
# Fill in every CHANGE_ME value, then run \`npm run deploy\` again.

NODE_ENV=production
LOG_LEVEL=info
DOMAIN=${DOMAIN}
# Let's Encrypt account email (certificate expiry notices).
ACME_EMAIL=CHANGE_ME

# ---- Data stores (private Docker network only) ----
POSTGRES_PASSWORD=${PG}
DATABASE_URL=postgresql://pay2all:${PG}@postgres:5432/pay2all
REDIS_PASSWORD=${RD}
REDIS_URL=redis://:${RD}@redis:6379
KAFKA_BROKERS=kafka-1:29092,kafka-2:29092,kafka-3:29092
KAFKA_REPLICATION_FACTOR=3
KAFKA_CLUSTER_ID=$(url64 16 | cut -c1-22)

# ---- Secrets (rotate only with a plan: ENCRYPTION_KEY protects stored credentials) ----
ENCRYPTION_KEY=$(b64 32)
ENCRYPTION_KEY_ID=k1
JWT_ACCESS_SECRET=$(url64 48)
JWT_REFRESH_SECRET=$(url64 48)

# ---- Public URLs: one origin, API under /v1 ----
API_PUBLIC_URL=https://${DOMAIN}
WEB_PUBLIC_URL=https://${DOMAIN}
CORS_ALLOWED_ORIGINS=https://${DOMAIN}
API_INTERNAL_URL=http://pay2all-api:4000
TRUST_PROXY_HOPS=1
SWAGGER_ENABLED=false
WEBHOOK_REQUIRE_HTTPS=true
# TEST issues pk_test_ API keys. Switch to LIVE only once real gateways are connected and tested.
API_ENVIRONMENT=TEST

# ---- Files: local disk on a Docker volume (choose it under Settings → File Storage) ----
LOCAL_STORAGE_ROOT=/data/storage
S3_SSE=AES256

# ---- Email (required): e.g. Amazon SES SMTP, smtps://USER:PASS@email-smtp.ap-south-1.amazonaws.com:465 ----
SMTP_URL=CHANGE_ME
MAIL_FROM="Pay2All Payments <no-reply@${DOMAIN}>"

# ---- First super admin: created once, password printed once by the deploy ----
BOOTSTRAP_ADMIN_EMAIL=CHANGE_ME
BOOTSTRAP_ADMIN_NAME="Platform Super Admin"

# ---- Optional ----
SENTRY_DSN=
OTEL_EXPORTER_OTLP_ENDPOINT=
# Agents' Google Drive backups (docs/AGENTS.md §7). Redirect URI: https://${DOMAIN}/v1/public/agent-drive/callback
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
ENV
chmod 600 "$OUT"
echo "Created $OUT"
