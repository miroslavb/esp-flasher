#!/usr/bin/env bash
# Deploy the flasher: static site -> /var/www/esp-flasher, proxy -> /opt/fw-proxy.
# Idempotent; safe to re-run. Caddy config is NOT touched here (see README).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DST=/var/www/esp-flasher
SRV_DST=/opt/fw-proxy

echo "==> static site -> $WEB_DST"
mkdir -p "$WEB_DST"
rsync -a --delete "$SRC/web/" "$WEB_DST/"
chmod -R a+rX "$WEB_DST"

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
