#!/usr/bin/env bash
set -euo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
ROOT=${ALPHA_ROOT:-/var/lib/alpha-agent}
test -f "$SRC/review-cards.mjs"
test -f "$SRC/fetch-gex-snapshot.py"
test -f "$SRC/review-card-assets/trendAdaptiveLogo.svg"
mkdir -p "$ROOT/bin" "$ROOT/market-http/review-card-assets" "$ROOT/desk/review-card-delivery"
install -m 644 "$SRC/review-cards.mjs" "$ROOT/market-http/review-cards.mjs"
install -m 644 "$SRC/fetch-gex-snapshot.py" "$ROOT/market-http/fetch-gex-snapshot.py"
install -m 644 "$SRC/review-card-assets/trendAdaptiveLogo.svg" "$ROOT/market-http/review-card-assets/trendAdaptiveLogo.svg"
install -m 755 "$SRC/cron/alpha-review-cards.sh" "$ROOT/bin/alpha-review-cards.sh"
echo "两张复盘图 worker 已安装，复用既有每日任务，无新增定时器"
