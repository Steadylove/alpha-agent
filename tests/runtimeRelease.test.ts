import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

vi.setConfig({ testTimeout: 20_000 });
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const id = "test-release-123";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "runtime-deploy-")); dirs.push(root);
  const payload = `${root}/payload`, incoming = `${root}/incoming`, bin = `${root}/stubs`;
  for (const d of [payload, incoming, bin, `${root}/market-http`, `${root}/bin`, `${root}/units`, `${payload}/cron`, `${root}/previous`]) mkdirSync(d, { recursive: true });
  writeFileSync(`${root}/option-flow.env`, "EXAMPLE=keep-private\n");
  writeFileSync(`${root}/market-http/.env`, "DESK_STORE_SECRET=preserve-me\nOPTION_FLOW_IMAGE=alpha-option-flow:previous\n");
  writeFileSync(`${root}/market-http/docker-compose.yml`, "services: {}\n");
  writeFileSync(`${root}/market-http/compute.mjs`, "old-worker");
  writeFileSync(`${root}/bin/alpha-daily-quant.sh`, "old-cron");
  symlinkSync(`${root}/previous`, `${root}/runtime-current`);
  writeFileSync(`${payload}/verify-runtime.mjs`, 'if (process.env.TEST_PREFLIGHT_FAIL) process.exit(3);');
  for (const file of ["docker-compose.yml", "desk-http.mjs", "compute.mjs", "telegram.mjs", "option-flow.mjs", "nginx.conf.template"]) writeFileSync(`${payload}/${file}`, "new-release\n");
  for (const file of ["alpha-daily-quant.sh", "alpha-catalyst.sh", "alpha-review-macro.sh", "alpha-review-cards.sh", "runtime-env.sh", "alpha-daily-quant.service", "alpha-daily-quant.timer"]) writeFileSync(`${payload}/cron/${file}`, "new-release\n");
  execFileSync("tar", ["-czf", `${incoming}/runtime.tar.gz`, "-C", payload, "."]);
  writeFileSync(`${incoming}/option-flow-image.tar.gz`, "fake image for the Docker stub");
  for (const [file, checksum] of [["runtime.tar.gz", "runtime.sha256"], ["option-flow-image.tar.gz", "option-flow-image.sha256"]]) writeFileSync(`${incoming}/${checksum}`, `${createHash("sha256").update(readFileSync(`${incoming}/${file}`)).digest("hex")}  ${file}\n`);
  // Verify real archive checksums on both macOS and Linux without trusting the test shell stubs.
  writeFileSync(`${bin}/sha256sum`, '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
  for (const cmd of ["docker", "systemctl", "flock", "sleep", "curl"]) {
    writeFileSync(`${bin}/${cmd}`, `#!/bin/bash
printf '%s\\n' '${cmd}'" $*" >> "$ALPHA_ROOT/calls"
if [ '${cmd}' = flock ] && [ "$TEST_BUSY" = 1 ] && [ "$3" = 9 ]; then exit 1; fi
if [ '${cmd}' = docker ] && [ "$1" = compose ]; then
 case "$*" in *' up '*)
  if grep -q 'OPTION_FLOW_IMAGE=alpha-option-flow:test-release-123' "$ALPHA_ROOT/market-http/.env"; then echo new > "$ALPHA_ROOT/active-image"; else echo old > "$ALPHA_ROOT/active-image"; fi;;
 esac
fi
if [ '${cmd}' = curl ]; then
 if [ "$TEST_BAD_HEALTH" = 1 ] && [ "$(cat "$ALPHA_ROOT/active-image" 2>/dev/null)" = new ]; then printf 500; else printf 200; fi
fi
`, { mode: 0o755 });
  }
  const run = (env: Record<string, string> = {}) => spawnSync("bash", ["deploy/market-http/deploy.sh", incoming, id], { encoding: "utf8", timeout: 15000, env: { ...process.env, ALPHA_ROOT: root, ALPHA_SYSTEMD_DIR: `${root}/units`, PATH: `${bin}:${process.env.PATH}`, ...env } });
  return { root, incoming, run, calls: () => readFileSync(`${root}/calls`, "utf8") };
}
it("activates a validated artifact under both job locks, preserving secrets and using no-build containers", () => {
  const f = fixture();
  mkdirSync(`${f.root}/repo/.cache/gex`, { recursive: true });
  writeFileSync(`${f.root}/repo/.cache/gex/gex-20260928-2200.json`, "historical snapshot");
  const r = f.run(); expect(r.status, r.stderr).toBe(0);
  expect(readFileSync(`${f.root}/work/.cache/gex/gex-20260928-2200.json`, "utf8")).toBe("historical snapshot");
  expect(readFileSync(`${f.root}/repo/.cache/gex/gex-20260928-2200.json`, "utf8")).toBe("historical snapshot");
  expect(readlinkSync(`${f.root}/runtime-current`)).toBe(`${f.root}/releases/runtime-${id}`);
  expect(readFileSync(`${f.root}/market-http/.env`, "utf8")).toBe(`DESK_STORE_SECRET=preserve-me\nOPTION_FLOW_IMAGE=alpha-option-flow:${id}\n`);
  const calls = f.calls(); expect(calls).toContain("--no-build --pull never");
  expect(calls.indexOf("flock -w 7200 9")).toBeLessThan(calls.indexOf("flock -w 900 8"));
  expect(calls.indexOf("flock -w 900 8")).toBeLessThan(calls.indexOf("--force-recreate"));
  expect(calls).not.toMatch(/npm|npx|git reset|docker build/);
});
it.each(["runtime.tar.gz", "option-flow-image.tar.gz"])("rejects a damaged %s before switching anything", file => {
  const f = fixture(); writeFileSync(`${f.incoming}/${file}`, "corrupt");
  expect(f.run().status).not.toBe(0); expect(readlinkSync(`${f.root}/runtime-current`)).toBe(`${f.root}/previous`);
  expect(readFileSync(`${f.root}/market-http/compute.mjs`, "utf8")).toBe("old-worker");
  expect(f.calls()).not.toContain("docker load");
});
it("rejects incompatible runtime preflight without disturbing the current deployment", () => {
  const f = fixture(); expect(f.run({ TEST_PREFLIGHT_FAIL: "1" }).status).not.toBe(0);
  expect(readlinkSync(`${f.root}/runtime-current`)).toBe(`${f.root}/previous`); expect(f.calls()).not.toContain("docker load");
});
it("does not interrupt a writer if the shared-lock wait expires", () => {
  const f = fixture(); expect(f.run({ TEST_BUSY: "1" }).status).not.toBe(0);
  expect(readlinkSync(`${f.root}/runtime-current`)).toBe(`${f.root}/previous`); expect(f.calls()).not.toContain("--force-recreate");
});
it("restores the old pointer, private config and wrappers when new-service health fails", () => {
  const f = fixture(), r = f.run({ TEST_BAD_HEALTH: "1" }); expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("restoring previous runtime");
  expect(readlinkSync(`${f.root}/runtime-current`)).toBe(`${f.root}/previous`);
  expect(readFileSync(`${f.root}/market-http/.env`, "utf8")).toContain("OPTION_FLOW_IMAGE=alpha-option-flow:previous");
  expect(readFileSync(`${f.root}/market-http/compute.mjs`, "utf8")).toBe("old-worker");
  expect(readFileSync(`${f.root}/bin/alpha-daily-quant.sh`, "utf8")).toBe("old-cron");
  expect(readFileSync(`${f.root}/active-image`, "utf8").trim()).toBe("old");
});
it("runs a precompiled environment importer without accidentally invoking the env CLI", async () => {
  const { build } = await import("esbuild");
  const root = mkdtempSync(path.join(tmpdir(), "runtime-import-")); dirs.push(root);
  const file = `${root}/job.mjs`;
  await build({ stdin: { contents: 'import "./scripts/load-env"; console.log("JOB_ONLY");', resolveDir: process.cwd(), sourcefile: "test-entry.ts" }, bundle: true, platform: "node", format: "esm", banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, outfile: file });
  const r = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0); expect(r.stdout.trim()).toBe("JOB_ONLY");
});
