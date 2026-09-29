#!/usr/bin/env bash
# 北京时间周二到周六 08:30 跑：对应美东前一交易日收盘后约 4 小时。
# lastSettledSession 仍按 America/New_York 16:15 认定收盘日。
set -euo pipefail

ROOT=${ALPHA_ROOT:-/var/lib/alpha-agent}
MARKET=$ROOT/market
ENV_FILE=$ROOT/daily-quant.env
BOOK_PUSH_URL=${BOOK_PUSH_URL:-https://alpha-agent-eight.vercel.app/api/jobs/push-signal-book}

export TZ=Asia/Shanghai
export MARKET_DATA_DIR=$MARKET
export SIGNAL_POOL_PATH=${SIGNAL_POOL_PATH:-$ROOT/desk/signal-pool.json}
export OPTION_FLOW_PATH=${OPTION_FLOW_PATH:-$ROOT/desk/option-flow.json}
export PUSH_ROUTES_PATH=${PUSH_ROUTES_PATH:-$ROOT/desk/push-routes.json}
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

# Only retry idempotent data steps. Message delivery is deliberately outside this loop.
retry() {
  local name=$1 attempt
  shift
  for attempt in 1 2 3; do
    if "$@"; then
      log "ok ${name}（第 ${attempt} 次）"
      return 0
    fi
    log "失败 ${name}（${attempt}/3）"
    if [ "$attempt" -lt 3 ]; then sleep "${REVIEW_RETRY_SLEEP:-45}"; fi
  done
  return 1
}

fetch_gex() {
  GEX_OUTPUT_DIR="$ROOT/work/.cache/gex" python3 "$RUNTIME/fetch-gex-snapshot.py" || return 1
  env -u VERCEL MARKET_DATA_BASE_URL= node "$RUNTIME/jobs/check-daily-review.mjs" --stage=gex --file=.cache/gex/latest.json || return 1
  cp .cache/gex/latest.json "$MARKET/snapshots/gex.json"
  if [ -d .cache/gex/profiles ]; then
    mkdir -p "$MARKET/snapshots/gex-profiles"
    cp -a .cache/gex/profiles/. "$MARKET/snapshots/gex-profiles/"
  fi
}

check_review() {
  env -u VERCEL MARKET_DATA_BASE_URL= SIGNAL_JOURNAL_DIR="$ROOT/desk" node "$RUNTIME/jobs/check-daily-review.mjs"
}

build_review() {
  env -u VERCEL MARKET_DATA_BASE_URL= SIGNAL_JOURNAL_DIR="$ROOT/desk" LIVE_BOOKS_PATH="$ROOT/desk/live-books.json" node "$RUNTIME/jobs/build-daily-review.mjs" || return 1
  check_review
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

# Dependencies and JavaScript are installed by the CI release, never by this task.
. "$ROOT/bin/runtime-env.sh"
for job in refresh-market-csv run-daily-jobs build-flow-research check-daily-review build-daily-review push-gex-card push-daily-screener build-review-analysis supplement-review-macro push-review-cards; do
  test -f "$RUNTIME/jobs/$job.mjs" || { echo "CI 任务产物缺失：$job" >&2; exit 1; }
done
test -f "$RUNTIME/fetch-gex-snapshot.py"

log "补行情"
refresh_ok=0
for attempt in 1 2 3; do
  if node "$RUNTIME/jobs/refresh-market-csv.mjs"; then
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

# Independent research archive; never coupled to GEX or message delivery.
soft flow-research env -u VERCEL MARKET_DATA_BASE_URL= OPTION_FLOW_PATH="$ROOT/desk/option-flow.json" node "$RUNTIME/jobs/build-flow-research.mjs" --daily
soft jobs:daily node "$RUNTIME/jobs/run-daily-jobs.mjs"
failed=0
gex_ok=0
review_ok=0
if retry gex fetch_gex; then gex_ok=1; else failed=1; fi

log "算账本"
docker exec alpha-book wget -qO- --post-data='' --timeout=600 http://127.0.0.1:8081/live-books >/dev/null

log "生成每日复盘与信号跟踪"
# 同机读取不可变信号档案和已算好的账本；不读取网页构建时的数据副本。
if retry daily-review build_review; then review_ok=1; else failed=1; fi
# 主任务已经持有同一把锁，直接运行独立 worker，不再进入补采锁脚本。
if [ -f "$RUNTIME/jobs/supplement-review-macro.mjs" ]; then
  soft daily-review-macro env -u VERCEL MARKET_DATA_BASE_URL= node "$RUNTIME/jobs/supplement-review-macro.mjs"
  # Refresh the health report after supplementary macro observations change.
  if [ "$review_ok" -eq 1 ] && ! check_review; then failed=1; fi
fi

log "推账本"
curl -fsS -m 120 -X POST "$BOOK_PUSH_URL"

if [ "$gex_ok" -eq 1 ]; then
  soft gex-card node "$RUNTIME/jobs/push-gex-card.mjs"
else
  log "跳过 GEX 推送：本次采集或完整性校验失败"
fi
if [ "$gex_ok" -eq 1 ] && [ "$review_ok" -eq 1 ]; then
  if ! "$ROOT/bin/alpha-review-cards.sh"; then failed=1; fi
else
  log "跳过两张复盘图：本次 GEX 或每日复盘未完成"
fi
soft screener env SCREENER_SKIP_AI=true node "$RUNTIME/jobs/push-daily-screener.mjs"

# Reads this session's saved review even when optional inputs (e.g. GEX) are partial.
# Keep model latency/failure outside the original data and delivery path.
soft review-analysis env -u VERCEL MARKET_DATA_BASE_URL= node "$RUNTIME/jobs/build-review-analysis.mjs"

if [ "$failed" -ne 0 ]; then
  log "结束：数据步骤重试后仍不完整，详情见 health-gex / health-review 与任务日志"
  exit 1
fi
log "结束"
