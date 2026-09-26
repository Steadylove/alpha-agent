#!/usr/bin/env bash
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
ROOT=/var/lib/alpha-agent
if [ ! -f "$ROOT/market-http/catalyst.mjs" ]; then
  echo 'Install the built catalyst.mjs in /var/lib/alpha-agent/market-http first.' >&2
  exit 1
fi
command -v node >/dev/null
command -v flock >/dev/null
mkdir -p "$ROOT/bin" "$ROOT/logs"
install -m 755 "$SRC/alpha-catalyst.sh" "$ROOT/bin/alpha-catalyst.sh"
for unit in alpha-catalyst.service alpha-catalyst.timer alpha-catalyst-analysis.service alpha-catalyst-analysis.timer; do
  install -m 644 "$SRC/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now alpha-catalyst.timer alpha-catalyst-analysis.timer
systemctl list-timers alpha-catalyst.timer alpha-catalyst-analysis.timer --no-pager
