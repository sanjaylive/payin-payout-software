#!/usr/bin/env bash
# npm run deploy [-- --skip-checks] [-- --rollback <release>]
#
# Ships the committed HEAD to one server over SSH and (re)starts the Docker Compose stack
# (docs/DEPLOYMENT.md). Steps: local checks → copy source (git archive) → build the image on the
# server → migrate + bootstrap → start → health check. Target settings come from deploy.env.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
[ -f deploy.env ] && set -a && . ./deploy.env && set +a

DEPLOY_HOST=${DEPLOY_HOST:-}
DEPLOY_USER=${DEPLOY_USER:-deploy}
DEPLOY_PORT=${DEPLOY_PORT:-22}
DEPLOY_DIR=${DEPLOY_DIR:-/opt/pay2all}
DOMAIN=${DOMAIN:-py.2all.co.in}
# caddy: this stack owns 80/443. nginx: an existing nginx on the server proxies to loopback ports.
DEPLOY_PROXY=${DEPLOY_PROXY:-caddy}
API_HOST_PORT=${API_HOST_PORT:-4500}
WEB_HOST_PORT=${WEB_HOST_PORT:-3500}
# Refuse to build or start when the server has less memory available than this (MB).
DEPLOY_MIN_AVAILABLE_MB=${DEPLOY_MIN_AVAILABLE_MB:-3000}
KEEP_RELEASES=5

SKIP_CHECKS=0
ROLLBACK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-checks) SKIP_CHECKS=1 ;;
    --rollback) ROLLBACK=${2:?--rollback needs a release id}; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$DEPLOY_HOST" ] || die "Set DEPLOY_HOST in deploy.env (copy infra/deploy/deploy.env.example)."
SSH=(ssh -p "$DEPLOY_PORT" -o BatchMode=yes -o ConnectTimeout=15 "$DEPLOY_USER@$DEPLOY_HOST")
remote() { "${SSH[@]}" "set -euo pipefail; $*"; }

ENV_FILE="$DEPLOY_DIR/.env.production"
case "$DEPLOY_PROXY" in
  caddy) COMPOSE_FILES="-f infra/deploy/compose.yml --profile caddy"; EDGE=caddy ;;
  nginx) COMPOSE_FILES="-f infra/deploy/compose.yml -f infra/deploy/compose.nginx.yml"; EDGE="" ;;
  *) die "DEPLOY_PROXY must be caddy or nginx" ;;
esac
compose() { # compose <release> <args…> — runs in that release's directory on the server
  local rel=$1; shift
  remote "cd '$DEPLOY_DIR/releases/$rel' && APP_RELEASE='$rel' ENV_FILE='$ENV_FILE' API_HOST_PORT='$API_HOST_PORT' WEB_HOST_PORT='$WEB_HOST_PORT' docker compose -p pay2all $COMPOSE_FILES --env-file '$ENV_FILE' $*"
}

check_memory() { # needs the release on the server (uses its helper script)
  local rel=$1 total avail ours
  read -r total avail ours < <(remote "bash '$DEPLOY_DIR/releases/$rel/infra/deploy/available-memory.sh'")
  echo "Server memory: ${avail} MB available + ${ours} MB held by the running Pay2All release"
  [ "$total" -ge "$DEPLOY_MIN_AVAILABLE_MB" ] || die "Only ${total} MB free for Pay2All on the server (need ${DEPLOY_MIN_AVAILABLE_MB}). Building or starting now could starve the other sites on it. Add RAM first (or lower DEPLOY_MIN_AVAILABLE_MB if you are sure)."
}

install_nginx_site() { # nginx mode: vhost from infra/deploy/nginx, certificate via certbot webroot
  local rel=$1 dir="$DEPLOY_DIR/releases/$1/infra/deploy/nginx" acme
  remote "sudo -n true" || die "nginx mode needs passwordless sudo for $DEPLOY_USER on the server."
  if ! remote "sudo -n test -f '/etc/letsencrypt/live/$DOMAIN/fullchain.pem'"; then
    say "Issuing the TLS certificate for $DOMAIN (Let's Encrypt, webroot)"
    acme=$(remote "grep -E '^ACME_EMAIL=' '$ENV_FILE' | cut -d= -f2-")
    remote "bash '$dir/install-site.sh' '$dir/site-http.conf' '$DOMAIN' '$API_HOST_PORT' '$WEB_HOST_PORT'" || die "nginx rejected the temporary vhost; nothing else was changed."
    remote "sudo -n mkdir -p /var/www/html && sudo -n certbot certonly --webroot -w /var/www/html -d '$DOMAIN' -m '$acme' --agree-tos --no-eff-email -n --deploy-hook 'systemctl reload nginx'" \
      || die "certbot could not issue the certificate. Check that $DOMAIN resolves to $DEPLOY_HOST."
  fi
  remote "bash '$dir/install-site.sh' '$dir/site.conf' '$DOMAIN' '$API_HOST_PORT' '$WEB_HOST_PORT'" || die "nginx rejected the vhost; the previous one was restored."
}

say "Checking the server ($DEPLOY_USER@$DEPLOY_HOST)"
remote "command -v docker >/dev/null && docker compose version >/dev/null" || die "Docker Engine with the compose plugin is required on the server."
remote "mkdir -p '$DEPLOY_DIR/releases' 2>/dev/null || { sudo -n mkdir -p '$DEPLOY_DIR/releases' && sudo -n chown -R \$(id -un): '$DEPLOY_DIR'; }" \
  || die "Cannot create $DEPLOY_DIR on the server (no write access and no passwordless sudo)."
remote "chmod 750 '$DEPLOY_DIR'"

if [ -n "$ROLLBACK" ]; then
  remote "test -d '$DEPLOY_DIR/releases/$ROLLBACK' && docker image inspect 'pay2all-app:$ROLLBACK' >/dev/null" || die "Release $ROLLBACK is not on the server."
  say "Rolling back to $ROLLBACK (database migrations are not reversed)"
  compose "$ROLLBACK" up -d --wait --remove-orphans api
  compose "$ROLLBACK" up -d --remove-orphans jobs worker web $EDGE
  remote "ln -sfn 'releases/$ROLLBACK' '$DEPLOY_DIR/current'"
  echo "Now serving $ROLLBACK."
  exit 0
fi

# ---- Local checks -----------------------------------------------------------------------------
[ -z "$(git status --porcelain)" ] || die "Commit or stash your changes first: only committed code is deployed."
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = main ] || [ "${DEPLOY_ALLOW_BRANCH:-}" = "$BRANCH" ] || die "Deploys go from main (on $BRANCH). Set DEPLOY_ALLOW_BRANCH=$BRANCH to override."
REL=$(git rev-parse --short=12 HEAD)
if [ "$SKIP_CHECKS" = 0 ]; then
  say "Typecheck, lint and unit tests"
  pnpm typecheck && pnpm lint && pnpm test || die "Checks failed; nothing was deployed."
fi

# ---- Ship and build ---------------------------------------------------------------------------
say "Uploading release $REL"
git archive --format=tar HEAD | "${SSH[@]}" "set -euo pipefail; rm -rf '$DEPLOY_DIR/releases/$REL.tmp'; mkdir -p '$DEPLOY_DIR/releases/$REL.tmp'; tar -x -C '$DEPLOY_DIR/releases/$REL.tmp'; rm -rf '$DEPLOY_DIR/releases/$REL'; mv '$DEPLOY_DIR/releases/$REL.tmp' '$DEPLOY_DIR/releases/$REL'"

if ! remote "test -f '$ENV_FILE'"; then
  say "First deploy: creating $ENV_FILE on the server with fresh secrets"
  remote "bash '$DEPLOY_DIR/releases/$REL/infra/deploy/init-env.sh' '$ENV_FILE' '$DOMAIN'"
  die "Now edit $ENV_FILE on the server (ssh $DEPLOY_USER@$DEPLOY_HOST) and replace every CHANGE_ME, then run npm run deploy again."
fi
MISSING=$(remote "grep -o '^[A-Z_]*=CHANGE_ME' '$ENV_FILE' | cut -d= -f1 | tr '\n' ' '" || true)
[ -z "$MISSING" ] || die "Still CHANGE_ME in $ENV_FILE on the server: $MISSING"
remote "grep -q '^DOMAIN=$DOMAIN\$' '$ENV_FILE'" || die "DOMAIN in $ENV_FILE differs from $DOMAIN (deploy.env)."

check_memory "$REL"
say "Building image pay2all-app:$REL on the server (first build takes a few minutes)"
remote "cd '$DEPLOY_DIR/releases/$REL' && docker build -f infra/deploy/Dockerfile --build-arg PUBLIC_URL='https://$DOMAIN' --build-arg APP_RELEASE='$REL' -t 'pay2all-app:$REL' ."

# ---- Migrate and start ------------------------------------------------------------------------
say "Starting data stores"
compose "$REL" up -d --wait postgres redis
compose "$REL" up -d --wait kafka-1 kafka-2 kafka-3

say "Migrating the database and bootstrapping (a first super admin's password is shown once below)"
compose "$REL" --profile migrate run --rm migrate

say "Starting the application"
compose "$REL" up -d --wait --remove-orphans api
compose "$REL" up -d --remove-orphans jobs worker web $EDGE
if [ "$DEPLOY_PROXY" = nginx ]; then install_nginx_site "$REL"; fi
remote "ln -sfn 'releases/$REL' '$DEPLOY_DIR/current'"

# ---- Verify and tidy --------------------------------------------------------------------------
say "Health check https://$DOMAIN"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$DOMAIN/v1/brand" && curl -fsS -o /dev/null "https://$DOMAIN/login"; then ok=1; break; fi
  sleep 4
done
if [ "$ok" = 1 ]; then echo "https://$DOMAIN is up (release $REL)."
else echo "⚠ https://$DOMAIN did not answer yet. Check DNS (A record → $DEPLOY_HOST), ports 80/443, and: ssh $DEPLOY_USER@$DEPLOY_HOST 'docker compose -p pay2all logs --tail 100 api web'"; fi

remote "cd '$DEPLOY_DIR/releases' && ls -1t | grep -v -x '$REL' | tail -n +$KEEP_RELEASES | while read -r old; do rm -rf \"\$old\"; docker image rm \"pay2all-app:\$old\" >/dev/null 2>&1 || true; done; docker builder prune -f --filter until=168h >/dev/null 2>&1 || true"
echo "Rollback, if needed: npm run deploy -- --rollback <previous release>"
