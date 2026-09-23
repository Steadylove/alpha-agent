#!/usr/bin/env bash
# 北京时间每天 12:30 额外补采一次，仅更新复盘宏观缺项。
set -euo pipefail
ROOT=${ALPHA_ROOT:-/var/lib/alpha-agent}
mkdir -p "$ROOT/logs"
exec 9>"$ROOT/daily-quant.lock"
if ! flock -n 9; then
  echo "主任务正在运行，跳过本次宏观补采"
  exit 0
fi
if [ -f "$ROOT/daily-quant.env" ]; then
  set -a
  . "$ROOT/daily-quant.env"
  set +a
fi
export TZ=Asia/Shanghai
export MARKET_DATA_DIR="$ROOT/market"
export MARKET_DATA_BASE_URL=''
unset VERCEL
echo "$(date '+%F %T %Z') 开始宏观补采"
node "$ROOT/market-http/review-macro.mjs"
echo "$(date '+%F %T %Z') 宏观补采结束"
