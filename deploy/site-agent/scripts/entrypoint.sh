#!/bin/sh
set -eu

# Fail closed before the HTTP worker can accept work; use synthetic data only.
node /opt/site-agent/scripts/verify-sandbox.mjs
exec "$@"
