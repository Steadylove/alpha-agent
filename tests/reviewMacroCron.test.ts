import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

function run(failCommand = "") {
  const root = mkdtempSync(path.join(tmpdir(), "alpha-macro-cron-test-"));
  try {
    const bin = path.join(root, "bin"),
      calls = path.join(root, "calls");
    mkdirSync(bin);
    writeFileSync(
      path.join(root, "daily-quant.env"),
      "MARKET_DATA_BASE_URL=https://remote.invalid\nVERCEL=1\n",
    );
    for (const cmd of ["node", "flock", "npm", "git", "docker", "curl"]) {
      writeFileSync(
        path.join(bin, cmd),
        `#!/bin/bash
printf '%s\\n' '${cmd}' >> "$TEST_CALLS"
if [ '${cmd}' = "$TEST_FAIL_COMMAND" ]; then exit 1; fi
if [ '${cmd}' = 'node' ]; then
  test "$1" = "$ALPHA_ROOT/market-http/review-macro.mjs" || exit 2
  test "$MARKET_DATA_DIR" = "$ALPHA_ROOT/market" || exit 3
  test -z "$MARKET_DATA_BASE_URL" || exit 4
  test -z "\${VERCEL:-}" || exit 5
fi
`,
        { mode: 0o755 },
      );
    }
    let failed = false;
    try {
      execFileSync(
        "bash",
        [
          new URL(
            "../deploy/market-http/cron/alpha-review-macro.sh",
            import.meta.url,
          ).pathname,
        ],
        {
          env: {
            ...process.env,
            ALPHA_ROOT: root,
            PATH: `${bin}:${process.env.PATH}`,
            TEST_CALLS: calls,
            TEST_FAIL_COMMAND: failCommand,
          },
          stdio: "pipe",
          timeout: 5000,
        },
      );
    } catch {
      failed = true;
    }
    return { failed, calls: readFileSync(calls, "utf8").trim().split("\n") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("补采只运行独立脚本，强制读取本地存储，不触发主任务或消息推送", () => {
  expect(run()).toEqual({ failed: false, calls: ["flock", "node"] });
});
it("主任务占用锁时直接跳过", () => {
  expect(run("flock")).toEqual({ failed: false, calls: ["flock"] });
});
it("采集失败将失败状态交给 systemd", () => {
  expect(run("node")).toEqual({ failed: true, calls: ["flock", "node"] });
});
