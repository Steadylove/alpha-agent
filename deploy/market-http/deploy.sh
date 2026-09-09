#!/usr/bin/env bash
# 在 VPS 上重装行情 HTTP。
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
DEST=/var/lib/alpha-agent/market-http

mkdir -p "$DEST" /var/lib/alpha-agent/desk
cp "$SRC/docker-compose.yml" "$DEST/docker-compose.yml"
cp "$SRC/nginx.conf.template" "$DEST/nginx.conf"
cp "$SRC/desk-http.mjs" "$DEST/desk-http.mjs"

wait_http() {
  local url=$1 name=$2
  local i=0 code=000
  while [ "$i" -lt 30 ]; do
    i=$((i + 1))
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "$url" || true)
    if [ "$code" = "200" ]; then
      printf '%s' "$code"
      return 0
    fi
    sleep 1
  done
  echo "${name}自检失败 HTTP ${code}" >&2
  exit 1
}

cd "$DEST"
docker compose up -d --force-recreate
code=$(wait_http "http://127.0.0.1:8787/MANIFEST.json" "行情")
desk=$(wait_http "http://127.0.0.1:8787/desk/lookback-snapshots.json" "desk")
echo "行情服务已部署  http://127.0.0.1:8787  自检 ${code}  desk ${desk}"
