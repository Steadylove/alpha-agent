#!/usr/bin/env bash
# 在行情机上把 /var/lib/alpha-agent/market 打成一份可搬走的 tar.gz。
set -euo pipefail
ROOT="${MARKET_DATA_DIR:-/var/lib/alpha-agent/market}"
OUT="${1:-/var/lib/alpha-agent/alpha-market-$(date +%Y%m%d).tar.gz}"
test -d "$ROOT/1d" || { echo "没有 $ROOT/1d，先同步行情"; exit 1; }
tar -C "$ROOT" -czf "$OUT" 1d 4h 2h 1h rps MANIFEST.json
ls -lh "$OUT"
echo "$OUT"

# 解包：tar -C /var/lib/alpha-agent/market -xzf alpha-market-YYYYMMDD.tar.gz
