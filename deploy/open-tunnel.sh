#!/bin/sh
set -eu
# Local 18018 avoids port conflicts; localhost keeps cookies separate from 127.0.0.1 dev.
echo "Workbench: http://localhost:18018/"
echo "Gateway desktop: http://localhost:18080/vnc.html"
echo "Keep this terminal open; Ctrl-C closes only the SSH access tunnel."
exec ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30     -o ServerAliveCountMax=3     -L 127.0.0.1:18018:127.0.0.1:8018     -L 127.0.0.1:18080:127.0.0.1:6080     "${1:-root@192.210.241.6}"
