#!/usr/bin/env bash
# Deploy the flasher: static site -> /var/www/esp-flasher, proxy -> /opt/fw-proxy.
# Idempotent; safe to re-run. Caddy config is NOT touched here (see README).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DST=/var/www/esp-flasher
SRV_DST=/opt/fw-proxy

# Paths inside the web root that other repos deploy (own firmware + project
# pages, e.g. /root/projects/sleep-radar/web). --delete must not erase them.
KEEP=(fw sleep-radar)

echo "==> static site -> $WEB_DST (keeping: ${KEEP[*]})"
mkdir -p "$WEB_DST"
EXCLUDES=()
for d in "${KEEP[@]}"; do EXCLUDES+=(--exclude "/$d/"); done
rsync -a --delete "${EXCLUDES[@]}" "$SRC/web/" "$WEB_DST/"
chmod -R a+rX "$WEB_DST"

# The live proxy runs on a separate host in the current deployment and the static
# root above is mirrored to the public front proxy, so by default only the static
# site is updated here. DEPLOY_PROXY=1 also installs and (re)starts the local
# fw-proxy (rollback / single-host setups).
if [ "${DEPLOY_PROXY:-0}" != "1" ]; then
  echo "==> proxy skipped (set DEPLOY_PROXY=1 to install/restart the local fw-proxy)"
  echo "==> done"
  exit 0
fi

echo "==> proxy -> $SRV_DST"
mkdir -p "$SRV_DST" /var/cache/fw-proxy/bins
install -m 0755 "$SRC/server/fwproxy.py" "$SRV_DST/fwproxy.py"
install -m 0644 "$SRC/server/fw-proxy.service" /etc/systemd/system/fw-proxy.service

systemctl daemon-reload
systemctl enable --now fw-proxy.service
systemctl restart fw-proxy.service

echo "==> waiting for health"
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8781/api/health >/dev/null 2>&1; then
    echo "    healthy after ${i}s"
    break
  fi
  sleep 1
done

curl -fsS http://127.0.0.1:8781/api/health && echo
echo "==> done. Reload Caddy if the vhost changed: systemctl reload caddy"
