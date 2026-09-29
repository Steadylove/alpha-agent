#!/usr/bin/env bash
# Accept a CI-produced Linux release. No package manager, compiler or source checkout runs here.
set -Eeuo pipefail
umask 077
ROOT=${ALPHA_ROOT:-/var/lib/alpha-agent}
SYSTEMD_DIR=${ALPHA_SYSTEMD_DIR:-/etc/systemd/system}
SRC=$(cd "${1:?Usage: deploy.sh ARTIFACT_DIRECTORY RELEASE_ID}" && pwd)
ID=${2:?Release ID required}
[[ "$ID" =~ ^[a-z0-9-]{7,80}$ ]] || { echo "Invalid release ID" >&2; exit 2; }
IMAGE="alpha-option-flow:$ID"
DEST="$ROOT/market-http"
RELEASE="$ROOT/releases/runtime-$ID"
STAGE="$ROOT/releases/.runtime-$ID-$$"
mkdir -p "$ROOT/releases" "$ROOT/bin" "$ROOT/logs" "$DEST" "$SYSTEMD_DIR"
exec 7>"$ROOT/deploy.lock"
flock -w 7200 7
for cmd in node docker python3 tar sha256sum flock; do command -v "$cmd" >/dev/null; done
test -f "$ROOT/option-flow.env"
available_kb=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')
if [ "$available_kb" -lt 2097152 ]; then echo "部署至少需要 2 GiB 剩余磁盘空间；保留当前运行版本" >&2; exit 1; fi
# The checksums cover native packages/fonts as well as compiled JavaScript.
(cd "$SRC" && sha256sum -c runtime.sha256 && sha256sum -c option-flow-image.sha256)
if [ -e "$RELEASE" ]; then
  cmp "$SRC/runtime.sha256" "$RELEASE/archive.sha256"
else
  mkdir "$STAGE"
  trap 'rm -rf -- "$STAGE"' EXIT
  tar -xzf "$SRC/runtime.tar.gz" -C "$STAGE"
  node "$STAGE/verify-runtime.mjs" "$ID"
  cp "$SRC/runtime.sha256" "$STAGE/archive.sha256"
  mv "$STAGE" "$RELEASE"
  trap - EXIT
fi
node "$RELEASE/verify-runtime.mjs" "$ID"
docker load -i "$SRC/option-flow-image.tar.gz"
docker image inspect "$IMAGE" >/dev/null

# Both writers and the standalone card sender finish before release pointers or containers change.
exec 9>"$ROOT/daily-quant.lock"
flock -w 7200 9
exec 8>"$ROOT/review-cards.lock"
flock -w 900 8
BACKUP="$ROOT/private-backups/runtime-deploy-$ID-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP/units"
cp -a "$DEST" "$BACKUP/market-http"
cp -a "$ROOT/bin" "$BACKUP/bin"
OLD=$(readlink "$ROOT/runtime-current" || true)
for unit in "$RELEASE"/cron/*.service "$RELEASE"/cron/*.timer; do
  name=$(basename "$unit")
  if [ -f "$SYSTEMD_DIR/$name" ]; then cp -a "$SYSTEMD_DIR/$name" "$BACKUP/units/$name"; fi
done
printf '%s\n' "$OLD" >"$BACKUP/previous-runtime"
printf '%s\n' "$RELEASE" >"$BACKUP/new-runtime"

wait_http() {
  local endpoint=$1 i code
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "http://127.0.0.1:8787/$endpoint" || true)
    [ "$code" = 200 ] && return 0
    sleep 1
  done
  echo "Health check failed: $endpoint ($code)" >&2
  return 1
}
switch_runtime() {
  python3 - "$ROOT/runtime-current" "$1" <<'PY'
import os,sys
target=sys.argv[1]; temp=target+'.'+str(os.getpid())
os.symlink(sys.argv[2],temp);os.replace(temp,target)
PY
}
rollback() {
  local status=$?
  trap - ERR INT TERM
  set +e
  echo "Deployment failed; restoring previous runtime and services" >&2
  cp -a "$BACKUP/market-http/." "$DEST/"
  cp -a "$BACKUP/bin/." "$ROOT/bin/"
  for unit in "$RELEASE"/cron/*.service "$RELEASE"/cron/*.timer; do
    name=$(basename "$unit")
    if [ -f "$BACKUP/units/$name" ]; then cp -a "$BACKUP/units/$name" "$SYSTEMD_DIR/$name"; else rm -f "$SYSTEMD_DIR/$name"; fi
  done
  if [ -n "$OLD" ]; then switch_runtime "$OLD"; else rm -f "$ROOT/runtime-current"; fi
  systemctl daemon-reload
  docker compose --project-directory "$DEST" -f "$DEST/docker-compose.yml" up -d --no-build --pull never --force-recreate
  for endpoint in MANIFEST.json compute/health telegram/health option-flow/health; do wait_http "$endpoint" || true; done
  echo "Backup for investigation: $BACKUP" >&2
  [ "$status" -ne 0 ] || status=1
  exit "$status"
}
trap rollback ERR INT TERM

# Preserve the collector's timestamped GEX archive on the first checkout-to-artifact migration.
# Never replace a cache already created by a runtime release, or remove the old archive.
if [ -d "$ROOT/repo/.cache/gex" ] && [ ! -e "$ROOT/work/.cache/gex" ]; then
  mkdir -p "$ROOT/work/.cache"
  cp -a "$ROOT/repo/.cache/gex" "$ROOT/work/.cache/gex"
fi

for name in docker-compose.yml desk-http.mjs compute.mjs telegram.mjs option-flow.mjs; do
  install -m 644 "$RELEASE/$name" "$DEST/$name"
done
install -m 644 "$RELEASE/nginx.conf.template" "$DEST/nginx.conf"
# Preserve private values in the existing .env; change only the non-secret image tag.
python3 - "$DEST/.env" "$IMAGE" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); lines=p.read_text().splitlines() if p.exists() else []
lines=[line for line in lines if not line.startswith('OPTION_FLOW_IMAGE=')]
p.write_text('\n'.join(lines+['OPTION_FLOW_IMAGE='+sys.argv[2]])+'\n');p.chmod(0o600)
PY
docker compose --project-directory "$DEST" -f "$DEST/docker-compose.yml" config --quiet
for name in alpha-daily-quant.sh alpha-catalyst.sh alpha-review-macro.sh alpha-review-cards.sh runtime-env.sh; do
  install -m 755 "$RELEASE/cron/$name" "$ROOT/bin/$name"
done
for unit in "$RELEASE"/cron/*.service "$RELEASE"/cron/*.timer; do install -m 644 "$unit" "$SYSTEMD_DIR/$(basename "$unit")"; done
switch_runtime "$RELEASE"
docker compose --project-directory "$DEST" -f "$DEST/docker-compose.yml" up -d --no-build --pull never --force-recreate
for endpoint in MANIFEST.json desk/lookback-snapshots.json compute/health telegram/health option-flow/health; do wait_http "$endpoint"; done
systemctl daemon-reload
# Enable existing schedules without restarting active timers or invoking any sender.
systemctl enable --now alpha-daily-quant.timer alpha-review-macro.timer alpha-catalyst.timer alpha-catalyst-analysis.timer
trap - ERR INT TERM
printf 'CI runtime deployed: %s\nRollback backup: %s\n' "$ID" "$BACKUP"
# Bound only our immutable build artifacts, never market data, private files or backups.
# Keep the current, previous and one extra release; running scheduled jobs are still locked.
python3 - "$ROOT" "$RELEASE" "$OLD" "$SRC" <<'PY' || echo "旧构建产物清理未完成，请检查磁盘；当前版本已健康上线" >&2
import json,pathlib,shutil,subprocess,sys
root=pathlib.Path(sys.argv[1]); current=pathlib.Path(sys.argv[2]); previous=pathlib.Path(sys.argv[3]) if sys.argv[3] else None
candidates=[]
for p in (root/'releases').glob('runtime-*'):
    if p.is_symlink() or not p.is_dir(): continue
    try: info=json.loads((p/'runtime.json').read_text())
    except (OSError,ValueError): continue
    if info.get('version')==1 and p.name=='runtime-'+info.get('revision',''): candidates.append((p,info['revision']))
keep={current,previous}
for p,_ in sorted(candidates,key=lambda x:x[0].stat().st_mtime,reverse=True):
    if len(keep-{None})<3: keep.add(p)
for p,revision in candidates:
    if p not in keep:
        shutil.rmtree(p)
        subprocess.run(['docker','image','rm','alpha-option-flow:'+revision],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        print('Removed obsolete runtime:',revision)
source=pathlib.Path(sys.argv[4])
if source.parent==root/'releases/incoming':
    for name in ['runtime.tar.gz','option-flow-image.tar.gz']:
        (source/name).unlink(missing_ok=True)
PY
