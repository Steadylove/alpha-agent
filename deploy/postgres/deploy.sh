#!/usr/bin/env bash
# 在 VPS 上起 Postgres。密码只写本机文件，不进 git。
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
ROOT=/var/lib/alpha-agent
DEST=$ROOT/postgres
PASSFILE=$ROOT/pg-pass
ENVFILE=$ROOT/postgres.env
HOST=108.174.50.53

mkdir -p "$DEST" "$ROOT/pgdata" /root/.ssh

if [ ! -s "$PASSFILE" ]; then
  openssl rand -base64 24 | tr -d '\n/+=' > "$PASSFILE"
  chmod 600 "$PASSFILE"
fi
PASS=$(cat "$PASSFILE")

if [ -f "$SRC/operator.pub" ]; then
  pub=$(awk '{print $2}' "$SRC/operator.pub")
  if [ -n "$pub" ] && ! grep -qF "$pub" /root/.ssh/authorized_keys 2>/dev/null; then
    cat "$SRC/operator.pub" >> /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
  fi
fi

umask 077
printf 'POSTGRES_DB=alpha_agent\nPOSTGRES_USER=alpha\nPOSTGRES_PASSWORD=%s\n' "$PASS" > "$DEST/.env"

python3 - "$PASS" "$HOST" "$ENVFILE" <<'PY'
import sys, urllib.parse
from pathlib import Path
pw, host, dest = sys.argv[1], sys.argv[2], sys.argv[3]
url = (
    "postgresql://alpha:"
    + urllib.parse.quote(pw, safe="")
    + f"@{host}:5432/alpha_agent?sslmode=disable"
)
Path(dest).write_text(
    "DATABASE_URL=" + url + "\n"
    "POSTGRES_USER=alpha\n"
    "POSTGRES_DB=alpha_agent\n"
    "POSTGRES_HOST=" + host + "\n",
    encoding="utf-8",
)
PY
chmod 600 "$ENVFILE" "$DEST/.env"

cp "$SRC/docker-compose.yml" "$DEST/docker-compose.yml"
cd "$DEST"
docker compose --env-file "$DEST/.env" up -d

ok=0
for _ in $(seq 1 40); do
  if docker exec alpha-postgres pg_isready -U alpha -d alpha_agent >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  echo "Postgres 未就绪" >&2
  docker compose logs --tail 80
  exit 1
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 5432/tcp comment "alpha-postgres" || true
fi

echo "Postgres 已启动  ${HOST}:5432  db=alpha_agent"
echo "连接串在 ${ENVFILE}（不要打印到日志）"
