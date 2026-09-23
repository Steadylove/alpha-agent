import "dotenv/config";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readRpsSnapshot } from "@/lib/backtest/rpsSnapshot";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { snapshotFile, writeSnapshot } from "@/lib/vps/snapshot";
import {
  expectedReviewSession,
  gexHealth,
  reviewHealth,
  type HealthIssues,
} from "@/lib/review/health";
import { reviewTf, signalDay } from "@/lib/review/journal";
import type { EntrySnapshot } from "@/lib/signals/assessment";
import type { GexSnapshot } from "@/lib/options/structure";

const stage =
  process.argv.find((a) => a.startsWith("--stage="))?.slice(8) ?? "review";
const file = process.argv.find((a) => a.startsWith("--file="))?.slice(7);
const read = <T>(file: string): T | null =>
  existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
let expected: string | null = null,
  issues: HealthIssues;
try {
  if (marketBaseUrl()) throw new Error("完整性检查必须在本地行情目录运行");
  if (!["gex", "review"].includes(stage)) throw new Error("Unknown stage");
  const session = expectedReviewSession(readRpsSnapshot()?.calendar);
  expected = session.date;
  if (stage === "gex")
    issues = gexHealth(
      read<GexSnapshot>(file ?? snapshotFile("gex")),
      session.date,
    );
  else {
    const dir = path.join(
      process.env.SIGNAL_JOURNAL_DIR || ".cache/signal-journal",
      "signal-entries",
    );
    if (!existsSync(dir))
      throw new Error("原始信号目录缺失，不能将其当作零信号");
    const entries = readdirSync(dir)
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .map((n) => read<EntrySnapshot>(path.join(dir, n))!);
    const entryIds = entries
      .filter(
        (e) =>
          e.payload.event === "buy" &&
          reviewTf(e.payload.tf) &&
          signalDay(e.payload.entrySignalTime!) <= session.date &&
          signalDay(Date.parse(e.capturedAt)) <= session.date,
      )
      .map((e) => e.id);
    issues = reviewHealth({
      ...session,
      entryIds,
      index: read(snapshotFile("daily-review/index")),
      review: read(snapshotFile(`daily-review/${session.date}`)),
      journal: read(snapshotFile("daily-review/journal")),
      publication: read(snapshotFile("daily-review/options-context")),
    });
  }
} catch (error) {
  issues = {
    errors: [error instanceof Error ? error.message : "检查失败"],
    warnings: [],
  };
}
const report = {
  version: 1,
  stage,
  expectedDate: expected,
  checkedAt: new Date().toISOString(),
  status: issues.errors.length
    ? "failed"
    : issues.warnings.length
      ? "degraded"
      : "ok",
  ...issues,
};
if (["gex", "review"].includes(stage))
  writeSnapshot(`daily-review/health-${stage}`, report);
console.log(JSON.stringify(report, null, 2));
if (issues.errors.length) process.exitCode = 1;
