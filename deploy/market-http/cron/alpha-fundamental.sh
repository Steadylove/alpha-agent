#!/usr/bin/env bash
# Isolated valuation job. Run manual refreshes through this wrapper on the VPS too.
set -euo pipefail
ROOT=${ALPHA_ROOT:-/var/lib/alpha-agent}
dry_run=false
for arg in "$@"; do [ "$arg" != '--dry-run' ] || dry_run=true; done
if [ "$dry_run" = false ]; then
  mkdir -p "$ROOT/logs"
  # Shared with deploy.sh; no strategy/delivery lock is acquired by this job.
  exec 9>"$ROOT/fundamental.lock"
  if ! flock -n 9; then
    echo '{"symbol":null,"status":"lock-busy","reasonsCount":0}'
    exit 0
  fi
fi
if [ -f "$ROOT/daily-quant.env" ]; then
  set -a
  . "$ROOT/daily-quant.env"
  set +a
fi
export TZ=Asia/Shanghai
export SIGNAL_POOL_PATH="$ROOT/desk/signal-pool.json"
export SIGNAL_JOURNAL_DIR="$ROOT/desk"
export LIVE_BOOKS_PATH="$ROOT/desk/live-books.json"
export MARKET_DATA_DIR="$ROOT/market"
export MARKET_DATA_BASE_URL=''
unset VERCEL
if [ "$dry_run" = true ]; then
  # runtime-env.sh creates a work directory; dry-run must remain read-only.
  RUNTIME=$(readlink -f "${ALPHA_RUNTIME:-$ROOT/runtime-current}" || true)
  if [ ! -f "$RUNTIME/runtime.json" ] || [ ! -d "$RUNTIME/node_modules" ]; then
    echo '{"symbol":null,"status":"runtime-unavailable","reasonsCount":1}' >&2
    exit 1
  fi
  cd "$ROOT"
else
  . "$ROOT/bin/runtime-env.sh"
fi
node "$RUNTIME/jobs/build-fundamental-targets.mjs" "$@"
