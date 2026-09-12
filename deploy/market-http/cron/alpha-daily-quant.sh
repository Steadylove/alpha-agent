#!/usr/bin/env bash
# 北京时间周二到周六 08:30 跑：对应美东前一交易日收盘后约 4 小时。
# lastSettledSession 仍按 America/New_York 16:15 认定收盘日。
set -euo pipefail

ROOT=/var/lib/alpha-agent
REPO=$ROOT/repo
MARKET=$ROOT/market
ENV_FILE=$ROOT/daily-quant.env
STAMP=$REPO/.npm-ci.stamp
BOOK_PUSH_URL=${BOOK_PUSH_URL:-https://alpha-agent-eight.vercel.app/api/jobs/push-signal-book}

export TZ=Asia/Shanghai
export MARKET_DATA_DIR=$MARKET
export ALPACA_FEED=${ALPACA_FEED:-sip}

mkdir -p "$ROOT/logs" "$MARKET/snapshots"
exec 9>"$ROOT/daily-quant.lock"
if ! flock -n 9; then
  echo "daily-quant 已在跑，退出"
  exit 0
fi

log() {
  printf '%s %s\n' "$(date '+%F %T %Z')" "$*"
}

soft() {
  local name=$1
  shift
  if "$@"; then
    log "ok $name"
  else
    log "skip ${name}（不挡账本）"
  fi
}

log "开始  北京=$(date '+%F %T %Z')  美东=$(TZ=America/New_York date '+%F %T %Z')  UTC=$(date -u '+%F %T %Z')"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
if [ -z "${ALPACA_API_KEY:-}" ] || [ -z "${ALPACA_API_SECRET:-}" ]; then
  echo "缺少 $ENV_FILE 里的 ALPACA_API_KEY / ALPACA_API_SECRET" >&2
  exit 1
fi

if [ ! -d "$REPO/.git" ]; then
  git clone --depth 1 https://github.com/Steadylove/alpha-agent.git "$REPO"
fi
cd "$REPO"
git fetch --depth 1 origin main
git reset --hard origin/main

lock_hash=$(sha256sum package-lock.json | awk '{print $1}')
if [ ! -d node_modules ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$lock_hash" ]; then
  npm ci
  printf '%s\n' "$lock_hash" >"$STAMP"
fi

log "补行情"
refresh_ok=0
for attempt in 1 2 3; do
  if npm run market:refresh; then
    refresh_ok=1
    break
  fi
  log "行情刷新失败，重试 ${attempt}/3"
  sleep "${MARKET_REFRESH_RETRY_SLEEP:-45}"
done
if [ "$refresh_ok" -ne 1 ]; then
  echo "行情刷新三次失败，停止发账本" >&2
  exit 1
fi

soft jobs:daily npm run jobs:daily
soft gex python3 scripts/fetch-gex-snapshot.py
if [ -f .cache/gex/latest.json ]; then
  cp .cache/gex/latest.json "$MARKET/snapshots/gex.json"
fi

log "算账本"
docker exec alpha-book wget -qO- --post-data='' --timeout=600 http://127.0.0.1:8081/live-books >/dev/null

log "推账本"
curl -fsS -m 120 -X POST "$BOOK_PUSH_URL"

soft gex-card npx --yes tsx scripts/push-gex-card.ts
soft screener env SCREENER_SKIP_AI=true npm run screener:push

log "结束"
