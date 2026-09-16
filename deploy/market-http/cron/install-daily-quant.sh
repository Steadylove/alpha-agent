#!/usr/bin/env bash
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
mkdir -p /var/lib/alpha-agent/bin /var/lib/alpha-agent/logs
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends fonts-noto-cjk fontconfig
if [ ! -f /etc/fonts/conf.d/99-alpha-noto.conf ]; then
  cat >/etc/fonts/conf.d/99-alpha-noto.conf <<'XML'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <alias>
    <family>Noto Sans SC</family>
    <prefer><family>Noto Sans CJK SC</family></prefer>
  </alias>
</fontconfig>
XML
  fc-cache -f
fi
cp "$SRC/alpha-daily-quant.sh" /var/lib/alpha-agent/bin/alpha-daily-quant.sh
chmod 755 /var/lib/alpha-agent/bin/alpha-daily-quant.sh
cp "$SRC/alpha-daily-quant.service" /etc/systemd/system/alpha-daily-quant.service
cp "$SRC/alpha-daily-quant.timer" /etc/systemd/system/alpha-daily-quant.timer
systemctl daemon-reload
systemctl enable --now alpha-daily-quant.timer
systemctl list-timers alpha-daily-quant.timer --no-pager
