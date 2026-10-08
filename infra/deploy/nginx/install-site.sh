#!/usr/bin/env bash
# Runs ON THE SERVER (via scripts/deploy.sh, DEPLOY_PROXY=nginx) with passwordless sudo.
# Renders a vhost template, installs it, tests the whole nginx config, and reloads. If the test fails
# the previous vhost is restored, so a bad Pay2All vhost can never take down other sites on this nginx.
# Usage: install-site.sh <template> <domain> <api_port> <web_port>
set -euo pipefail
TEMPLATE=${1:?template}; DOMAIN=${2:?domain}; API_PORT=${3:?api port}; WEB_PORT=${4:?web port}
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ ]] || { echo "bad domain" >&2; exit 2; }
[[ "$API_PORT$WEB_PORT" =~ ^[0-9]+$ ]] || { echo "bad port" >&2; exit 2; }
CONF=/etc/nginx/sites-available/pay2all-$DOMAIN.conf
LINK=/etc/nginx/sites-enabled/pay2all-$DOMAIN.conf

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__API_PORT__/$API_PORT/g" -e "s/__WEB_PORT__/$WEB_PORT/g" "$TEMPLATE" > "$tmp"
if sudo -n test -f "$CONF" && sudo -n cmp -s "$tmp" "$CONF"; then echo "nginx vhost unchanged"; exit 0; fi

had_old=0
if sudo -n test -f "$CONF"; then sudo -n cp -a "$CONF" "$CONF.bak"; had_old=1; fi
sudo -n install -m 644 "$tmp" "$CONF"
sudo -n ln -sfn "$CONF" "$LINK"
if sudo -n nginx -t >/dev/null 2>&1; then
  sudo -n systemctl reload nginx
  sudo -n rm -f "$CONF.bak"
  echo "nginx vhost installed for $DOMAIN"
else
  if [ "$had_old" = 1 ]; then sudo -n mv "$CONF.bak" "$CONF"; else sudo -n rm -f "$LINK" "$CONF"; fi
  echo "nginx -t failed; previous configuration restored:" >&2
  sudo -n nginx -t >&2 || true
  exit 1
fi
