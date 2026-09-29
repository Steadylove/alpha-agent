# Sourced after taking the task lock and loading private environment values.
# Pin an immutable release for this entire invocation; no network installation fallback.
RUNTIME=$(readlink -f "${ALPHA_RUNTIME:-$ROOT/runtime-current}" || true)
if [ ! -f "$RUNTIME/runtime.json" ] || [ ! -d "$RUNTIME/node_modules" ]; then
  echo "CI 运行产物缺失，停止任务；请部署完整发布包" >&2
  exit 1
fi
export ALPHA_RUNTIME="$RUNTIME"
export FONTCONFIG_FILE="$RUNTIME/fontconfig.conf"
export REVIEW_CARD_ASSET_DIR="$RUNTIME/review-card-assets"
# Mutable caches are independent of both the old checkout and release directories.
mkdir -p "$ROOT/work"
cd "$ROOT/work"
