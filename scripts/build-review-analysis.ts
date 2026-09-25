import "dotenv/config";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { readRpsSnapshot } from "@/lib/backtest/rpsSnapshot";
import { snapshotDir } from "@/lib/vps/snapshot";
import { expectedReviewSession } from "@/lib/review/health";
import { buildReviewAnalysis } from "@/lib/review/analysis/service";

async function main() {
  if (marketBaseUrl()) throw new Error("请在本地行情目录运行分析，避免写入网页服务器临时磁盘");
  const args = process.argv.slice(2);
  if (args.some((s) => !["--force", "--dry-run"].includes(s) && !/^--date=\d{4}-\d{2}-\d{2}$/.test(s)))
    throw new Error("用法：review:analysis [--date=YYYY-MM-DD] [--force] [--dry-run]");
  const date = args.find((s) => s.startsWith("--date="))?.slice(7) ??
    expectedReviewSession(readRpsSnapshot()?.calendar).date;
  // Hidden, outside public snapshots; daily/manual invocations must not pay for the same request concurrently.
  const lockFile = path.join(path.dirname(snapshotDir()), ".review-analysis.lock");
  mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd: number;
  try { fd = openSync(lockFile, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(readFileSync(lockFile, "utf8"));
    if (!Number.isInteger(pid) || pid < 1) throw new Error("分析锁无效，请检查后移除 .review-analysis.lock");
    try { process.kill(pid, 0); throw new Error("已有分析任务运行中"); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
    unlinkSync(lockFile);
    fd = openSync(lockFile, "wx", 0o600);
  }
  try {
    writeFileSync(fd, String(process.pid));
    const result = await buildReviewAnalysis({ date, apiKey: process.env.DEEPSEEK_REVIEW_API_KEY || process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_REVIEW_MODEL, force: args.includes("--force"), dryRun: args.includes("--dry-run") });
    console.log(JSON.stringify(result));
  } finally { closeSync(fd); unlinkSync(lockFile); }
}

main().catch((error: unknown) => {
  // No raw provider response, request, key, or chain of thought in logs/public files.
  const safe = error instanceof Error && !/https?:|bearer|sk-|\n/i.test(error.message)
    ? error.message.slice(0, 180) : "分析任务失败，请检查数据与服务配置";
  console.error(`[review-analysis] ${safe}`);
  process.exitCode = 1;
});
