#!/usr/bin/env bash
set -euo pipefail
# Read-only reuse of the already logged-in Gateway; no public API port is opened.
target="${1:-root@192.210.241.6}"
gateway_ip=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$target" "docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ibkr-desk-gateway-1")
if [[ ! "$gateway_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Cannot identify the Gateway private IP." >&2
  exit 1
fi
printf 'Gateway tunnel: 127.0.0.1:14001 (keep this terminal open)\n'
exec ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L "127.0.0.1:14001:${gateway_ip}:5001" "$target"
