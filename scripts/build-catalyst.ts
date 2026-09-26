import "dotenv/config";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { snapshotDir } from "@/lib/vps/snapshot";
import { buildCatalystReport } from "@/lib/catalyst/build";

class CliError extends Error {}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--analyze", "--dry-run"].includes(arg))) throw new CliError("用法：catalyst:build [--analyze] [--dry-run]");
  if (marketBaseUrl()) throw new CliError("请在本地行情目录运行 Catalyst，避免写入网页服务器临时磁盘");
  const options = { analyze: args.includes("--analyze"), dryRun: args.includes("--dry-run") };
  // Dry-run is genuinely read-only, including no lock/directory creation or model calls.
  if (options.dryRun) {
    await buildCatalystReport(options);
    console.log(JSON.stringify({ ok: true, dryRun: true, analyze: false }));
    return;
  }
  const lockFile = path.join(path.dirname(snapshotDir()), ".catalyst.lock");
  mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd: number;
  try { fd = openSync(lockFile, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(readFileSync(lockFile, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new CliError("Catalyst 锁无效，请检查 .catalyst.lock");
    try { process.kill(pid, 0); throw new CliError("已有 Catalyst 任务运行中"); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
    unlinkSync(lockFile);
    fd = openSync(lockFile, "wx", 0o600);
  }
  try {
    writeFileSync(fd, String(process.pid));
    const result = await buildCatalystReport(options);
    console.log(JSON.stringify({ ok: true, dryRun: false, analyze: options.analyze, reviewDigest: "reviewDigest" in result ? result.reviewDigest : undefined }));
  } finally {
    closeSync(fd);
    unlinkSync(lockFile);
  }
}

main().catch((error: unknown) => {
  // Only locally authored CLI messages are printable; provider/body/env errors never reach logs.
  console.error(`[catalyst] ${error instanceof CliError ? error.message : "任务失败，请检查行情目录、事件归档和服务配置"}`);
  process.exitCode = 1;
});
