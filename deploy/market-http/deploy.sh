#!/usr/bin/env bash
# 在 VPS 上重装行情 HTTP。
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
DEST=/var/lib/alpha-agent/market-http

mkdir -p "$DEST" /var/lib/alpha-agent/desk /var/lib/alpha-agent/telegram /var/lib/alpha-agent/telegram-config
if [ ! -f "$SRC/compute.mjs" ]; then
  echo "缺少 compute.mjs，先在仓库跑 npm run book:worker:bundle" >&2
  exit 1
fi
if [ ! -f "$SRC/telegram.mjs" ]; then
  echo "缺少 telegram.mjs，先在仓库跑 npm run telegram:worker:bundle" >&2
  exit 1
fi
if [ ! -f "$SRC/option-flow.mjs" ]; then
  echo "缺少 option-flow.mjs，先在仓库跑 npm run option-flow:worker:bundle" >&2
  exit 1
fi
if [ ! -f /var/lib/alpha-agent/option-flow.env ]; then
  echo "缺少 /var/lib/alpha-agent/option-flow.env" >&2
  exit 1
fi
cp "$SRC/docker-compose.yml" "$DEST/docker-compose.yml"
cp "$SRC/nginx.conf.template" "$DEST/nginx.conf"
cp "$SRC/desk-http.mjs" "$DEST/desk-http.mjs"
cp "$SRC/compute.mjs" "$DEST/compute.mjs"
cp "$SRC/telegram.mjs" "$DEST/telegram.mjs"
cp "$SRC/option-flow.mjs" "$DEST/option-flow.mjs"
cp "$SRC/option-flow.Dockerfile" "$DEST/option-flow.Dockerfile"

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

if [ -f "$SRC/cron/install-daily-quant.sh" ]; then
  bash "$SRC/cron/install-daily-quant.sh"
fi

cd "$DEST"
docker compose up -d --force-recreate
code=$(wait_http "http://127.0.0.1:8787/MANIFEST.json" "行情")
desk=$(wait_http "http://127.0.0.1:8787/desk/lookback-snapshots.json" "desk")
book=$(wait_http "http://127.0.0.1:8787/compute/health" "账本")
telegram=$(wait_http "http://127.0.0.1:8787/telegram/health" "Telegram")
flow=$(wait_http "http://127.0.0.1:8787/option-flow/health" "期权流")
echo "行情服务已部署  http://127.0.0.1:8787  自检 ${code}  desk ${desk}  book ${book}  Telegram ${telegram}  期权流 ${flow}"
