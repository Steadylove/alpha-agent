#!/usr/bin/env bash
# Independent event collector; never invokes the daily strategy or delivery jobs.
set -euo pipefail
ROOT=${ALPHA_ROOT:-/var/lib/alpha-agent}
analyze=false
for arg in "$@"; do
  case "$arg" in
    --analyze) analyze=true ;;
    --refresh-review-digest) ;;
    *) echo 'Usage: alpha-catalyst.sh [--analyze] [--refresh-review-digest]' >&2; exit 2 ;;
  esac
done
mkdir -p "$ROOT/logs"
exec 9>"$ROOT/daily-quant.lock"
if [ "$analyze" = true ]; then
  # Scheduled analysis follows the morning data job and also tolerates a bounded lock delay.
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
