#!/usr/bin/env bash
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
mkdir -p /var/lib/alpha-agent/bin /var/lib/alpha-agent/logs
# Native dependencies and fonts arrive in the CI release; no host package installation.
test -f /var/lib/alpha-agent/runtime-current/runtime.json
install -m 755 "$SRC/runtime-env.sh" /var/lib/alpha-agent/bin/runtime-env.sh
cp "$SRC/alpha-daily-quant.sh" /var/lib/alpha-agent/bin/alpha-daily-quant.sh
chmod 755 /var/lib/alpha-agent/bin/alpha-daily-quant.sh
cp "$SRC/alpha-daily-quant.service" /etc/systemd/system/alpha-daily-quant.service
cp "$SRC/alpha-daily-quant.timer" /etc/systemd/system/alpha-daily-quant.timer
systemctl daemon-reload
systemctl enable --now alpha-daily-quant.timer
systemctl list-timers alpha-daily-quant.timer --no-pager
