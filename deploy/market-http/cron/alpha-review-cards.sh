#!/usr/bin/env bash
# Called once by the daily close pipeline, or manually for safe retry. No extra timer.
set -euo pipefail
ROOT=${ALPHA_ROOT:-/var/lib/alpha-agent}
if [ -f "$ROOT/daily-quant.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ROOT/daily-quant.env"
  set +a
fi
export MARKET_DATA_DIR="$ROOT/market"
export MARKET_DATA_BASE_URL=
unset VERCEL
export PUSH_ROUTES_PATH="$ROOT/desk/push-routes.json"
export REVIEW_CARD_STATE_DIR="$ROOT/desk/review-card-delivery"
export REVIEW_CARD_ASSET_DIR="$ROOT/market-http/review-card-assets"
export REVIEW_CARD_TELEGRAM_CONFIG="$ROOT/telegram-config/telegram.config.mjs"
export TELEGRAM_RELAY_URL=${TELEGRAM_RELAY_URL:-http://127.0.0.1:8787/telegram}
exec 8>"$ROOT/review-cards.lock"
if ! flock -n 8; then echo "复盘图任务已在运行"; exit 0; fi
cd "$ROOT/repo"
node "$ROOT/market-http/review-cards.mjs" "$@"
