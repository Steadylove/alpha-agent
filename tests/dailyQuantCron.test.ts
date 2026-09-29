import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

// 每例启动多个 Bash 子进程；并行构建时给进程调度留出余量。
vi.setConfig({ testTimeout: 15_000 });

/** 跑实际 Bash 任务链，外部命令全部替换为记录调用的桩，不联网、不发消息。 */
function run(
  failCommand = "",
  macroWorker = false,
  failures = 99,
  installation: {
    missingMarker?: boolean;
    dependencyFailures?: number;
    installerExit?: number;
    timeoutExit?: number;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "alpha-daily-quant-test-"));
  try {
    const bin = path.join(root, "bin"),
      calls = path.join(root, "calls");
    mkdirSync(bin);
    mkdirSync(path.join(root, "repo/.git"), { recursive: true });
    mkdirSync(path.join(root, "repo/node_modules"));
    if (!installation.missingMarker) {
      writeFileSync(path.join(root, "repo/node_modules/.package-lock.json"), "{}");
    }
    mkdirSync(path.join(root, "repo/.cache/gex"), { recursive: true });
    writeFileSync(path.join(root, "repo/.cache/gex/latest.json"), "{}");
    if (macroWorker) {
      mkdirSync(path.join(root, "market-http"));
      writeFileSync(path.join(root, "market-http/review-macro.mjs"), "");
    }
    writeFileSync(path.join(root, "repo/.npm-ci.stamp"), "test-hash");
    writeFileSync(
      path.join(root, "daily-quant.env"),
      "ALPACA_API_KEY=test\nALPACA_API_SECRET=test\n",
    );
    for (const cmd of [
      "git",
      "npm",
      "python3",
      "docker",
      "curl",
      "flock",
      "npx",
      "sha256sum",
      "node",
      "timeout",
      "alpha-review-cards.sh",
    ]) {
      writeFileSync(
        path.join(bin, cmd),
        `#!/bin/bash
call="${cmd} $*"
printf '%s\\n' "$call" >> "$TEST_CALLS"
if [ "$call" = "$TEST_FAIL_COMMAND" ]; then
 count=$(cat "$TEST_COUNT" 2>/dev/null || echo 0)
 count=$((count + 1))
 echo "$count" > "$TEST_COUNT"
 if [ "$count" -le "$TEST_FAILURES" ]; then exit 1; fi
fi
if [ '${cmd}' = 'sha256sum' ]; then echo test-hash; fi
if [ '${cmd}' = 'timeout' ]; then
 if [ "$TEST_TIMEOUT_EXIT" -ne 0 ]; then exit "$TEST_TIMEOUT_EXIT"; fi
 shift 2
 exec "$@"
fi
if [ '${cmd}' = 'npm' ] && [ "$1" = 'ci' ]; then
 printf 'installer NODE_OPTIONS=%s\\n' "$NODE_OPTIONS" >> "$TEST_CALLS"
 if [ "$TEST_INSTALLER_EXIT" -ne 0 ]; then exit "$TEST_INSTALLER_EXIT"; fi
 mkdir -p node_modules
 echo '{}' > node_modules/.package-lock.json
fi
if [ '${cmd}' = 'node' ] && [ "$1" = '-e' ]; then
 printf 'dependency-check NODE_OPTIONS=%s\\n' "$NODE_OPTIONS" >> "$TEST_CALLS"
 count=$(cat "$TEST_DEPENDENCY_COUNT" 2>/dev/null || echo 0)
 count=$((count + 1))
 echo "$count" > "$TEST_DEPENDENCY_COUNT"
 if [ "$count" -le "$TEST_DEPENDENCY_FAILURES" ]; then exit 1; fi
fi
`,
        { mode: 0o755 },
      );
    }
    const script = readFileSync(
      new URL(
        "../deploy/market-http/cron/alpha-daily-quant.sh",
        import.meta.url,
      ),
      "utf8",
    ).replace("ROOT=/var/lib/alpha-agent", `ROOT='${root}'`);
    const scriptFile = path.join(root, "run.sh");
    writeFileSync(scriptFile, script);
    let failed = false;
    let error = "";
    let output = "";
    try {
      output = execFileSync("bash", [scriptFile], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_CALLS: calls,
          TEST_FAIL_COMMAND: failCommand,
          TEST_FAILURES: String(failures),
          TEST_COUNT: path.join(root, "failure-count"),
          TEST_TIMEOUT_EXIT: String(installation.timeoutExit ?? 0),
          TEST_INSTALLER_EXIT: String(installation.installerExit ?? 0),
          TEST_DEPENDENCY_FAILURES: String(installation.dependencyFailures ?? 0),
          TEST_DEPENDENCY_COUNT: path.join(root, "dependency-count"),
          NODE_OPTIONS: "--stack-trace-limit=30",
          MARKET_REFRESH_RETRY_SLEEP: "0",
          REVIEW_RETRY_SLEEP: "0",
        },
        stdio: "pipe",
        encoding: "utf8",
        timeout: 10_000,
      });
    } catch (e) {
      failed = true;
      error = String(e);
    }
    const stamp = path.join(root, "repo/.npm-ci.stamp");
    return {
      failed,
      error,
      output,
      stamp: existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null,
      calls: readFileSync(calls, "utf8").split("\n"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("日更实际执行行情、账本、GEX 和筛选推送", () => {
  const result = run();
  expect(result.failed, result.error).toBe(false);
  const refresh = result.calls.indexOf("npm run market:refresh");
  const book = result.calls.findIndex((c) =>
    c.startsWith("docker exec alpha-book"),
  );
  const screener = result.calls.indexOf("npm run screener:push");
  expect(refresh).toBeGreaterThan(-1);
  expect(book).toBeGreaterThan(refresh);
  expect(screener).toBeGreaterThan(book);
  expect(result.calls).toContain("npx --yes tsx scripts/push-gex-card.ts");
  expect(result.calls.some((c) => c.startsWith("npm ci"))).toBe(false);
});

const installCommand = "npm ci --omit=dev --no-audit --no-fund --prefer-offline --maxsockets=2";

it("stamp 匹配但 npm 安装标记缺失时仍修复依赖，成功后才保存 stamp", () => {
  const result = run("", false, 99, { missingMarker: true });
  expect(result.failed, result.error).toBe(false);
  expect(result.calls).toContain(installCommand);
  expect(result.calls).toContain(
    `timeout --kill-after=30s 15m env NODE_OPTIONS=--max-old-space-size=256 ${installCommand}`,
  );
  expect(result.calls).toContain("installer NODE_OPTIONS=--max-old-space-size=256");
  expect(result.calls).toContain("dependency-check NODE_OPTIONS=--stack-trace-limit=30");
  expect(result.stamp).toBe("test-hash");
  expect(result.output).toContain("开始安装依赖");
  expect(result.output).toContain("依赖安装与校验完成");
});

it("stamp 和安装标记存在但运行依赖缺失时重新安装", () => {
  const result = run("", false, 99, { dependencyFailures: 1 });
  expect(result.failed, result.error).toBe(false);
  expect(result.calls).toContain(installCommand);
  expect(result.calls.filter((c) => c.startsWith("node -e "))).toHaveLength(2);
  expect(result.stamp).toBe("test-hash");
});

it.each([
  ["安装失败", { missingMarker: true, installerExit: 1 }],
  ["安装超时", { missingMarker: true, timeoutExit: 124 }],
  ["安装后依赖仍然不完整", { missingMarker: true, dependencyFailures: 1 }],
])("%s 清除旧 stamp 并停止后续数据和推送任务", (_, installation) => {
  const result = run("", false, 99, installation);
  expect(result.failed).toBe(true);
  expect(result.stamp).toBeNull();
  expect(result.calls).not.toContain("npm run market:refresh");
  expect(result.calls.some((c) =>
    c.startsWith("curl ") || c.startsWith("docker ") || c.includes("screener:push"),
  )).toBe(false);
});
it("主任务生成复盘后调用独立宏观补采，且只获取一次锁", () => {
  const result = run("", true);
  expect(result.failed, result.error).toBe(false);
  const review = result.calls.indexOf("npm run review:build");
  const macro = result.calls.findIndex(
    (c) => c.startsWith("node ") && c.endsWith("/market-http/review-macro.mjs"),
  );
  expect(macro).toBeGreaterThan(review);
  expect(result.calls.findIndex((c) => c.startsWith("curl "))).toBeGreaterThan(
    macro,
  );
  expect(result.calls.filter((c) => c.startsWith("flock "))).toHaveLength(1);
});
it("辅助任务失败不阻止账本和筛选推送", () => {
  const result = run("npm run jobs:daily");
  expect(result.failed, result.error).toBe(false);
  expect(result.calls.some((c) => c.startsWith("curl "))).toBe(true);
  expect(result.calls).toContain("npm run screener:push");
});
it("AI 分析在原推送之后独立运行，失败不改变原任务结果", () => {
  const result = run("npm run review:analysis", true);
  expect(result.failed, result.error).toBe(false);
  const analysis = result.calls.indexOf("npm run review:analysis");
  expect(analysis).toBeGreaterThan(result.calls.indexOf("npm run screener:push"));
  expect(analysis).toBeGreaterThan(result.calls.findIndex((c) => c.endsWith("/market-http/review-macro.mjs")));
  expect(result.calls.filter((c) => c === "npm run review:analysis")).toHaveLength(1);
  expect(result.calls.filter((c) => c.startsWith("curl "))).toHaveLength(1);
});
it("期权数据不完整仍尝试分析已归档复盘，保留原健康检查失败状态", () => {
  const result = run("python3 scripts/fetch-gex-snapshot.py");
  expect(result.failed).toBe(true);
  expect(result.calls).toContain("npm run review:analysis");
});
it("选股日更脚本不引用 Prisma，避免 VPS npm ci 后缺 generated client", () => {
  const src = readFileSync(
    new URL("../scripts/push-daily-screener.ts", import.meta.url),
    "utf8",
  );
  expect(src).not.toMatch(/prisma/i);
});
it("行情更新失败停止发布，避免推旧账本", () => {
  const result = run("npm run market:refresh");
  expect(result.failed).toBe(true);
  expect(
    result.calls.filter((c) => c === "npm run market:refresh"),
  ).toHaveLength(3);
  expect(
    result.calls.some(
      (c) => c.startsWith("curl ") || c.includes("screener:push"),
    ),
  ).toBe(false);
});

it("Gamma 失败三次后不推旧卡片，并以失败结束而非伪装成功", () => {
  const result = run("python3 scripts/fetch-gex-snapshot.py");
  expect(result.failed).toBe(true);
  expect(
    result.calls.filter((c) => c === "python3 scripts/fetch-gex-snapshot.py"),
  ).toHaveLength(3);
  expect(result.calls).not.toContain("npx --yes tsx scripts/push-gex-card.ts");
});
it("复盘校验未通过也重试，恢复后只推一次消息", () => {
  const result = run("npm run review:check", false, 2);
  expect(result.failed, result.error).toBe(false);
  expect(result.calls.filter((c) => c === "npm run review:build")).toHaveLength(
    3,
  );
  expect(result.calls.filter((c) => c.startsWith("curl "))).toHaveLength(1);
  expect(
    result.calls.filter((c) => c === "npx --yes tsx scripts/push-gex-card.ts"),
  ).toHaveLength(1);
});
it("Gamma 请求成功但快照日期过期，校验仍会触发重采", () => {
  const result = run(
    "npm run review:check -- --stage=gex --file=.cache/gex/latest.json",
    false,
    1,
  );
  expect(result.failed, result.error).toBe(false);
  expect(
    result.calls.filter((c) => c === "python3 scripts/fetch-gex-snapshot.py"),
  ).toHaveLength(2);
});
it("复盘生成连续失败以非零状态结束", () => {
  const result = run("npm run review:build");
  expect(result.failed).toBe(true);
  expect(result.calls.filter((c) => c === "npm run review:build")).toHaveLength(
    3,
  );
});
