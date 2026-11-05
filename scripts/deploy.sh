#!/usr/bin/env bash
# npm run deploy [-- --rollback <release>]
#
# Pushes the committed HEAD to GitHub, waits for the "Build image" workflow (checks + image build,
# .github/workflows/build-image.yml) and then has the server pull that finished image from GHCR and
# (re)start the Docker Compose stack (docs/DEPLOYMENT.md). Nothing is compiled on the server.
# Steps: push → wait for CI → upload infra/ → pull image → migrate + bootstrap → start → health
# check. Target settings come from deploy.env.
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
# Registry image built by CI. Default: ghcr.io/<owner>/<repo> of the "origin" remote.
DEPLOY_IMAGE=${DEPLOY_IMAGE:-}
# Only needed while the GHCR package is private: a token with read:packages only (never a full
# GitHub token), and its user. The server keeps the login in ~/.docker/config.json.
GHCR_PULL_USER=${GHCR_PULL_USER:-}
GHCR_PULL_TOKEN=${GHCR_PULL_TOKEN:-}
WORKFLOW=build-image.yml

ROLLBACK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rollback) ROLLBACK=${2:?--rollback needs a release id}; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
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

# ---- Push and wait for the CI build ------------------------------------------------------------
[ -z "$(git status --porcelain)" ] || die "Commit or stash your changes first: only committed code is deployed."
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = main ] || [ "${DEPLOY_ALLOW_BRANCH:-}" = "$BRANCH" ] || die "Deploys go from main (on $BRANCH). Set DEPLOY_ALLOW_BRANCH=$BRANCH to override."
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || die "The GitHub CLI (gh) must be installed and signed in (gh auth login)."
REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##') || true
[ -n "$REPO" ] || die "No GitHub remote named origin."
IMAGE=${DEPLOY_IMAGE:-ghcr.io/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')}
SHA=$(git rev-parse HEAD)
REL=${SHA:0:12}

say "Pushing $BRANCH to GitHub ($REPO)"
git push origin "$BRANCH" || die "git push failed; nothing was deployed."

say "Waiting for the image build of $REL on GitHub Actions"
RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID=$(gh run list -R "$REPO" --workflow "$WORKFLOW" --commit "$SHA" --event push --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
  [ -z "$RUN_ID" ] || break
  sleep 4
done
[ -n "$RUN_ID" ] || die "No \"Build image\" run started for $REL. Check https://github.com/$REPO/actions"
echo "https://github.com/$REPO/actions/runs/$RUN_ID"
gh run watch "$RUN_ID" -R "$REPO" --exit-status --interval 15 >/dev/null \
  || die "The CI build of $REL failed; nothing was deployed. Details: gh run view $RUN_ID -R $REPO --log-failed"
echo "Image $IMAGE:$REL is built."

# ---- Ship the deploy files and pull the image ---------------------------------------------------
ARCH=$(remote "uname -m")
[ "$ARCH" = x86_64 ] || die "The server is $ARCH, but CI builds linux/amd64 images."
say "Uploading the deploy files of release $REL"
git archive --format=tar HEAD infra | "${SSH[@]}" "set -euo pipefail; rm -rf '$DEPLOY_DIR/releases/$REL.tmp'; mkdir -p '$DEPLOY_DIR/releases/$REL.tmp'; tar -x -C '$DEPLOY_DIR/releases/$REL.tmp'; rm -rf '$DEPLOY_DIR/releases/$REL'; mv '$DEPLOY_DIR/releases/$REL.tmp' '$DEPLOY_DIR/releases/$REL'"

if ! remote "test -f '$ENV_FILE'"; then
  say "First deploy: creating $ENV_FILE on the server with fresh secrets"
  remote "bash '$DEPLOY_DIR/releases/$REL/infra/deploy/init-env.sh' '$ENV_FILE' '$DOMAIN'"
  die "Now edit $ENV_FILE on the server (ssh $DEPLOY_USER@$DEPLOY_HOST) and replace every CHANGE_ME, then run npm run deploy again."
fi
MISSING=$(remote "grep -o '^[A-Z_]*=CHANGE_ME' '$ENV_FILE' | cut -d= -f1 | tr '\n' ' '" || true)
[ -z "$MISSING" ] || die "Still CHANGE_ME in $ENV_FILE on the server: $MISSING"
remote "grep -q '^DOMAIN=$DOMAIN\$' '$ENV_FILE'" || die "DOMAIN in $ENV_FILE differs from $DOMAIN (deploy.env)."

check_memory "$REL"
if [ -n "$GHCR_PULL_TOKEN" ]; then
  printf '%s' "$GHCR_PULL_TOKEN" | "${SSH[@]}" "docker login ghcr.io -u '${GHCR_PULL_USER:?set GHCR_PULL_USER with GHCR_PULL_TOKEN}' --password-stdin >/dev/null" || die "docker login to ghcr.io failed on the server."
fi
say "Pulling $IMAGE:$REL on the server"
remote "docker pull -q '$IMAGE:$REL' && docker tag '$IMAGE:$REL' 'pay2all-app:$REL'" \
  || die "The server could not pull $IMAGE:$REL. If the GHCR package is private, make it public (GitHub → Packages → settings) or set GHCR_PULL_USER/GHCR_PULL_TOKEN (read:packages) in deploy.env."

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

remote "cd '$DEPLOY_DIR/releases' && { ls -1t | grep -v -x '$REL' || true; } | tail -n +$KEEP_RELEASES | while read -r old; do rm -rf \"\$old\"; docker image rm \"pay2all-app:\$old\" '$IMAGE':\"\$old\" >/dev/null 2>&1 || true; done; docker image prune -f >/dev/null 2>&1 || true"
echo "Rollback, if needed: npm run deploy -- --rollback <previous release>"
