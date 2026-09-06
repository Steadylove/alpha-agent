#!/usr/bin/env bash
# 在 VPS 上重装行情 HTTP。
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
DEST=/var/lib/alpha-agent/market-http

mkdir -p "$DEST"
cp "$SRC/docker-compose.yml" "$DEST/docker-compose.yml"
cp "$SRC/nginx.conf.template" "$DEST/nginx.conf"

cd "$DEST"
docker compose up -d --force-recreate
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8787/MANIFEST.json")
if [ "$code" != "200" ]; then
  echo "自检失败 HTTP ${code}" >&2
  exit 1
fi
echo "行情服务已部署  http://127.0.0.1:8787  自检 ${code}"
