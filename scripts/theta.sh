#!/usr/bin/env bash
set -euo pipefail
THETA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$THETA_ROOT"
THETA_VENV="$THETA_ROOT/.cache/thetadata-venv"
if [[ "${1:-}" == "setup" ]]; then
  if [[ ! -x "$THETA_VENV/bin/python" ]]; then
    uv --cache-dir "$THETA_ROOT/.cache/uv" venv --python "${THETA_PYTHON:-python3}" "$THETA_VENV"
  fi
  uv --cache-dir "$THETA_ROOT/.cache/uv" pip install --python "$THETA_VENV/bin/python" -r services/theta/requirements.txt
  exit 0
fi
if [[ ! -x "$THETA_VENV/bin/python" ]]; then
  echo "先运行 npm run theta:setup（需要 Python 3.12+ 和 uv）" >&2
  exit 1
fi
if [[ "${1:-}" == "test" ]]; then
  exec "$THETA_VENV/bin/python" -m unittest discover -s services/theta -p 'test_*.py' -v
fi
if [[ "${1:-}" == "batch" ]]; then
  shift
  exec "$THETA_VENV/bin/python" services/theta/batch.py "$@"
fi
if [[ "${1:-}" == "optimize" ]]; then
  shift
  exec "$THETA_VENV/bin/python" services/theta/optimize.py "$@"
fi
if [[ "${1:-}" == "forecast" ]]; then
  shift
  exec "$THETA_VENV/bin/python" services/theta/forecast.py "$@"
fi
if [[ "${1:-}" == "pde" ]]; then
  shift
  exec "$THETA_VENV/bin/python" services/theta/pde.py "$@"
fi
if [[ "${1:-}" == "calibrate" ]]; then
  shift
  exec "$THETA_VENV/bin/python" services/theta/pde_calibrate.py "$@"
fi
if [[ "${1:-}" == "search" ]]; then
  shift
  exec "$THETA_VENV/bin/python" services/theta/pde_search.py "$@"
fi
exec "$THETA_VENV/bin/python" services/theta/app.py "$@"
