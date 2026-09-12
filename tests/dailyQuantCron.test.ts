import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

/** 跑实际 Bash 任务链，外部命令全部替换为记录调用的桩，不联网、不发消息。 */
function run(failCommand = "") {
  const root = mkdtempSync(path.join(tmpdir(), "alpha-daily-quant-test-"));
  try {
    const bin = path.join(root, "bin"), calls = path.join(root, "calls");
    mkdirSync(bin);
    mkdirSync(path.join(root, "repo/.git"), { recursive: true });
    mkdirSync(path.join(root, "repo/node_modules"));
    writeFileSync(path.join(root, "repo/.npm-ci.stamp"), "test-hash");
    writeFileSync(path.join(root, "daily-quant.env"), "ALPACA_API_KEY=test\nALPACA_API_SECRET=test\n");
    for (const cmd of ["git", "npm", "python3", "docker", "curl", "flock", "npx", "sha256sum"]) {
      writeFileSync(path.join(bin, cmd), `#!/bin/bash\ncall="${cmd} $*"\nprintf '%s\\n' "$call" >> "$TEST_CALLS"\nif [ "$call" = "$TEST_FAIL_COMMAND" ]; then exit 1; fi\nif [ '${cmd}' = 'sha256sum' ]; then echo test-hash; fi\n`, { mode: 0o755 });
    }
    const script = readFileSync(new URL("../deploy/market-http/cron/alpha-daily-quant.sh", import.meta.url), "utf8")
      .replace("ROOT=/var/lib/alpha-agent", `ROOT='${root}'`);
    const scriptFile = path.join(root, "run.sh");
    writeFileSync(scriptFile, script);
    let failed = false;
    let error = "";
    try {
      execFileSync("bash", [scriptFile], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_CALLS: calls, TEST_FAIL_COMMAND: failCommand, MARKET_REFRESH_RETRY_SLEEP: "0" }, stdio: "pipe", timeout: 10_000 });
    } catch (e) { failed = true; error = String(e); }
    return { failed, error, calls: readFileSync(calls, "utf8").split("\n") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it("日更实际执行行情、账本、GEX 和筛选推送", () => {
  const result = run();
  expect(result.failed, result.error).toBe(false);
  const refresh = result.calls.indexOf("npm run market:refresh");
  const book = result.calls.findIndex((c) => c.startsWith("docker exec alpha-book"));
  const screener = result.calls.indexOf("npm run screener:push");
  expect(refresh).toBeGreaterThan(-1);
  expect(book).toBeGreaterThan(refresh);
  expect(screener).toBeGreaterThan(book);
  expect(result.calls).toContain("npx --yes tsx scripts/push-gex-card.ts");
});
it("辅助任务失败不阻止账本和筛选推送", () => {
  const result = run("npm run jobs:daily");
  expect(result.failed, result.error).toBe(false);
  expect(result.calls.some((c) => c.startsWith("curl "))).toBe(true);
  expect(result.calls).toContain("npm run screener:push");
});
it("行情更新失败停止发布，避免推旧账本", () => {
  const result = run("npm run market:refresh");
  expect(result.failed).toBe(true);
  expect(result.calls.filter((c) => c === "npm run market:refresh")).toHaveLength(3);
  expect(result.calls.some((c) => c.startsWith("curl ") || c.includes("screener:push"))).toBe(false);
});
