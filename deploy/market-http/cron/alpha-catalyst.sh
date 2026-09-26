#!/usr/bin/env bash
# Independent event collector; never invokes the daily strategy or delivery jobs.
set -euo pipefail
ROOT=${ALPHA_ROOT:-/var/lib/alpha-agent}
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != '--analyze' ]; }; then
  echo 'Usage: alpha-catalyst.sh [--analyze]' >&2
  exit 2
fi
mkdir -p "$ROOT/logs"
exec 9>"$ROOT/daily-quant.lock"
if [ "${1:-}" = '--analyze' ]; then
  # Give the 08:30 daily job time to finish before the 08:55 analysis reads its data.
  if ! flock -w 1800 9; then
    echo "$(date '+%F %T %Z') Catalyst 分析等待行情锁超时，未生成新分析" >&2
    exit 1
  fi
elif ! flock -n 9; then
  echo "$(date '+%F %T %Z') 行情主任务运行中，Catalyst 本轮采集跳过"
  exit 0
fi
if [ -f "$ROOT/daily-quant.env" ]; then
  set -a
  . "$ROOT/daily-quant.env"
  set +a
fi
export TZ=Asia/Shanghai
export MARKET_DATA_DIR="$ROOT/market"
export SIGNAL_JOURNAL_DIR="$ROOT/desk"
export LIVE_BOOKS_PATH="$ROOT/desk/live-books.json"
export MARKET_DATA_BASE_URL=''
unset VERCEL
cd "$ROOT/repo"
echo "$(date '+%F %T %Z') Catalyst 开始 ${1:-collect}"
node "$ROOT/market-http/catalyst.mjs" "$@"
echo "$(date '+%F %T %Z') Catalyst 完成"
