#!/usr/bin/env bash
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
ROOT=/var/lib/alpha-agent
test -f "$SRC/../review-macro.mjs"
mkdir -p "$ROOT/bin" "$ROOT/logs" "$ROOT/market-http"
install -m 644 "$SRC/../review-macro.mjs" "$ROOT/market-http/review-macro.mjs"
install -m 755 "$SRC/alpha-review-macro.sh" "$ROOT/bin/alpha-review-macro.sh"
install -m 644 "$SRC/alpha-review-macro.service" /etc/systemd/system/alpha-review-macro.service
install -m 644 "$SRC/alpha-review-macro.timer" /etc/systemd/system/alpha-review-macro.timer
systemctl daemon-reload
systemctl enable --now alpha-review-macro.timer
systemctl list-timers alpha-review-macro.timer --no-pager
