#!/bin/bash
set -euo pipefail
umask 077
mkdir -p "$HOME/Jts" "$HOME/.cache" /tmp/ibkr-runtime
export XDG_RUNTIME_DIR=/tmp/ibkr-runtime
if [[ ! -r /run/secrets/gateway_password ]]; then
    echo 'Missing remote desktop password file.' >&2
    exit 1
fi
cleanup() { trap - TERM INT EXIT; kill $(jobs -pr) 2>/dev/null || true; wait || true; }
trap cleanup TERM INT EXIT
Xvfb :1 -screen 0 1280x900x24 -nolisten tcp &
for attempt in {1..50}; do
    if xdpyinfo -display :1 >/dev/null 2>&1; then break; fi
    sleep .1
done
xdpyinfo -display :1 >/dev/null
openbox --sm-disable &
x11vnc -display :1 -localhost -rfbport 5900 -forever -shared     -passwdfile /run/secrets/gateway_password -noxdamage -quiet &
websockify --web=/usr/share/novnc/ 0.0.0.0:6080 127.0.0.1:5900 &
# These relays exist only on this stack's Docker network. Gateway sees localhost.
socat TCP-LISTEN:5001,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:4001 &
socat TCP-LISTEN:5002,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:4002 &
/opt/ibgateway/ibgateway -J-DjtsConfigDir="$HOME/Jts" &
echo 'Gateway desktop started; sign in through the private remote desktop.'
# Restart the container if the gateway or a required desktop process exits.
wait -n
exit 1
