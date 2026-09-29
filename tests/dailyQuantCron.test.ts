import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 15_000 });

/** Execute the real Bash chain; stubs record every outside action without fetching or sending. */
function run(failCommand = "", failures = 99, missing = "") {
  const root = mkdtempSync(path.join(tmpdir(), "alpha-daily-quant-test-"));
  try {
    for (const dir of ["bin", "runtime/jobs", "runtime/node_modules", "work/.cache/gex"]) mkdirSync(path.join(root, dir), { recursive: true });
    symlinkSync(path.join(root, "runtime"), path.join(root, "runtime-current"));
    writeFileSync(path.join(root, "runtime/runtime.json"), "{}");
    writeFileSync(path.join(root, "runtime/fetch-gex-snapshot.py"), "");
    for (const job of ["refresh-market-csv", "run-daily-jobs", "build-flow-research", "check-daily-review", "build-daily-review", "push-gex-card", "push-daily-screener", "build-review-analysis", "supplement-review-macro", "push-review-cards"]) writeFileSync(path.join(root, `runtime/jobs/${job}.mjs`), "");
    if (missing) rmSync(path.join(root, "runtime", missing), { recursive: true, force: true });
    writeFileSync(path.join(root, "bin/runtime-env.sh"), readFileSync("deploy/market-http/cron/runtime-env.sh"));
    writeFileSync(path.join(root, "work/.cache/gex/latest.json"), "{}");
    writeFileSync(path.join(root, "daily-quant.env"), "ALPACA_API_KEY=test\nALPACA_API_SECRET=test\n");
    const calls = path.join(root, "calls");
    writeFileSync(calls, "");
    for (const cmd of ["git", "npm", "npx", "python3", "docker", "curl", "flock", "node", "alpha-review-cards.sh"]) {
      writeFileSync(path.join(root, "bin", cmd), `#!/bin/bash
call="${cmd} $*"
if [ '${cmd}' = node ]; then first=$1; shift; call="node jobs/$(basename "$first") $*"; fi
if [ '${cmd}' = python3 ]; then call="python3 $(basename "$1")"; fi
call=$(printf '%s' "$call" | sed 's/ $//')
printf '%s\\n' "$call" >> "$TEST_CALLS"
if [ "$call" = "$TEST_FAIL_COMMAND" ]; then
 count=$(cat "$TEST_COUNT" 2>/dev/null || echo 0)
 count=$((count + 1)); echo "$count" > "$TEST_COUNT"
 if [ "$count" -le "$TEST_FAILURES" ]; then exit 1; fi
fi
`, { mode: 0o755 });
    }
    let failed = false, error = "", output = "";
    try {
      output = execFileSync("bash", ["deploy/market-http/cron/alpha-daily-quant.sh"], {
        env: { ...process.env, ALPHA_ROOT: root, ALPHA_RUNTIME: "", PATH: `${root}/bin:${process.env.PATH}`, TEST_CALLS: calls, TEST_FAIL_COMMAND: failCommand, TEST_FAILURES: String(failures), TEST_COUNT: `${root}/failures`, MARKET_REFRESH_RETRY_SLEEP: "0", REVIEW_RETRY_SLEEP: "0" },
        encoding: "utf8", stdio: "pipe", timeout: 10_000,
      });
    } catch (e) { failed = true; error = String(e); }
    return { failed, error, output, calls: readFileSync(calls, "utf8").trim().split("\n") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const job = (name: string) => `node jobs/${name}.mjs`;

it("uses CI bundles in the original data-before-delivery order without git/npm/npx", () => {
  const r = run(); expect(r.failed, r.error).toBe(false);
  const refresh = r.calls.indexOf(job("refresh-market-csv"));
  const book = r.calls.findIndex(c => c.startsWith("docker exec alpha-book"));
  const screener = r.calls.indexOf(job("push-daily-screener"));
  expect(refresh).toBeGreaterThan(-1); expect(book).toBeGreaterThan(refresh); expect(screener).toBeGreaterThan(book);
  expect(r.calls).toContain(job("push-gex-card"));
  expect(r.calls.some(c => /^(git|npm|npx) /.test(c))).toBe(false);
});
it.each(["runtime.json", "node_modules", "jobs/push-daily-screener.mjs"])("missing %s stops before data changes or delivery instead of installing", missing => {
  const r = run("", 99, missing); expect(r.failed).toBe(true);
  expect(r.calls.some(c => /^(git|npm|npx|curl|docker|python3|node) /.test(c))).toBe(false);
});
it("macro runs after review and before delivery under one shared lock", () => {
  const r = run(); expect(r.failed, r.error).toBe(false);
  const macro = r.calls.indexOf(job("supplement-review-macro"));
  expect(macro).toBeGreaterThan(r.calls.indexOf(job("build-daily-review")));
  expect(r.calls.findIndex(c => c.startsWith("curl "))).toBeGreaterThan(macro);
  expect(r.calls.filter(c => c.startsWith("flock "))).toHaveLength(1);
});
it("auxiliary jobs can fail without blocking account and screener delivery", () => {
  const r = run(job("run-daily-jobs")); expect(r.failed, r.error).toBe(false);
  expect(r.calls.some(c => c.startsWith("curl "))).toBe(true); expect(r.calls).toContain(job("push-daily-screener"));
});
it("AI failure remains independent and is attempted once after sending", () => {
  const r = run(job("build-review-analysis")); expect(r.failed, r.error).toBe(false);
  expect(r.calls.indexOf(job("build-review-analysis"))).toBeGreaterThan(r.calls.indexOf(job("push-daily-screener")));
  expect(r.calls.filter(c => c === job("build-review-analysis"))).toHaveLength(1);
  expect(r.calls.filter(c => c.startsWith("curl "))).toHaveLength(1);
});
it("missing Gamma still analyzes the saved review but retains failed job status", () => {
  const r = run("python3 fetch-gex-snapshot.py"); expect(r.failed).toBe(true); expect(r.calls).toContain(job("build-review-analysis"));
});
it("the daily screener has no retired database dependency", () => {
  expect(readFileSync("scripts/push-daily-screener.ts", "utf8")).not.toMatch(/prisma/i);
});
it("three failed refreshes stop before any delivery", () => {
  const r = run(job("refresh-market-csv")); expect(r.failed).toBe(true);
  expect(r.calls.filter(c => c === job("refresh-market-csv"))).toHaveLength(3);
  expect(r.calls.some(c => c.startsWith("curl ") || c.includes("push-daily-screener"))).toBe(false);
});
it("three failed Gamma fetches do not send stale Gamma cards", () => {
  const r = run("python3 fetch-gex-snapshot.py"); expect(r.failed).toBe(true);
  expect(r.calls.filter(c => c === "python3 fetch-gex-snapshot.py")).toHaveLength(3);
  expect(r.calls).not.toContain(job("push-gex-card"));
});
it("review validation retries safely and sends only once on recovery", () => {
  const r = run(job("check-daily-review"), 2); expect(r.failed, r.error).toBe(false);
  expect(r.calls.filter(c => c === job("build-daily-review"))).toHaveLength(3);
  expect(r.calls.filter(c => c.startsWith("curl "))).toHaveLength(1);
  expect(r.calls.filter(c => c === job("push-gex-card"))).toHaveLength(1);
});
it("a fetched but stale Gamma snapshot triggers re-collection", () => {
  const r = run(`${job("check-daily-review")} --stage=gex --file=.cache/gex/latest.json`, 1); expect(r.failed, r.error).toBe(false);
  expect(r.calls.filter(c => c === "python3 fetch-gex-snapshot.py")).toHaveLength(2);
});
