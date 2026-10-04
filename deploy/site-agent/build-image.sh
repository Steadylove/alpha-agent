#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VERSION=${SITE_AGENT_CODEX_VERSION:-0.160.0}
IMAGE=${SITE_AGENT_IMAGE:-alpha-site-agent:codex-$VERSION}
OUTPUT=${SITE_AGENT_OUTPUT_DIR:-$ROOT/dist/site-agent}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "SITE_AGENT_CODEX_VERSION must be an exact stable version" >&2; exit 1; }
mkdir -p "$OUTPUT"
CONTEXT_PARENT=$(mktemp -d)
trap 'rm -rf "$CONTEXT_PARENT"' EXIT
cd "$ROOT"
node --input-type=module <<'NODE'
import { build } from "esbuild";
await build({ entryPoints: ["scripts/site-agent.ts"], bundle: true, platform: "node", format: "esm",
  outfile: "dist/site-agent/site-agent.mjs", alias: { "@": "./src" } });
NODE
node deploy/site-agent/scripts/prepare-context.mjs "$CONTEXT_PARENT/context"
docker buildx build --platform linux/amd64 --load --build-arg "CODEX_VERSION=$VERSION" -t "$IMAGE" "$CONTEXT_PARENT/context"
docker save "$IMAGE" | gzip -1 > "$OUTPUT/site-agent-image.tar.gz"
cp deploy/site-agent/compose.yml "$OUTPUT/compose.yml"
cp deploy/site-agent/compose.sandbox.yml "$OUTPUT/compose.sandbox.yml"
mkdir -p "$OUTPUT/security"
cp deploy/site-agent/security/seccomp-docker-29.8.1.json deploy/site-agent/security/seccomp-site-agent.json deploy/site-agent/security/apparmor-site-agent "$OUTPUT/security/"
cd "$OUTPUT"
shasum -a 256 site-agent-image.tar.gz > site-agent-image.sha256
printf 'Built %s. Transfer the archive, checksum and compose.yml to the isolated service directory.\n' "$IMAGE"
