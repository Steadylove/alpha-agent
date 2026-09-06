#!/usr/bin/env bash
# 在 VPS 上重装行情 HTTP。token 只读本机文件，不进仓库。
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
DEST=/var/lib/alpha-agent/market-http
TOKEN_FILE=/var/lib/alpha-agent/market-token

if [ ! -s "$TOKEN_FILE" ]; then
  echo "缺少 $TOKEN_FILE" >&2
  exit 1
fi

TOKEN=$(tr -d '\n' < "$TOKEN_FILE")
mkdir -p "$DEST"
cp "$SRC/docker-compose.yml" "$DEST/docker-compose.yml"
sed "s|__MARKET_TOKEN__|${TOKEN}|g" "$SRC/nginx.conf.template" > "$DEST/nginx.conf"

cd "$DEST"
docker compose up -d --force-recreate
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8787/MANIFEST.json?t=${TOKEN}")
if [ "$code" != "200" ]; then
  echo "自检失败 HTTP ${code}" >&2
  exit 1
fi
echo "行情服务已部署  http://127.0.0.1:8787  自检 ${code}"
