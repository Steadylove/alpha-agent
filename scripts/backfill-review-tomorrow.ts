import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { buildFollowup } from "@/lib/review/followup";
import { readFollowupExits } from "@/lib/review/followupStore";
import { buildTomorrowMap } from "@/lib/review/tomorrow";
import { journalAsOf } from "@/lib/review/journal";
import type {
  DailyReview,
  JournalArchive,
  ReviewIndex,
} from "@/lib/review/types";
import type { RpsSnapshot } from "@/lib/backtest/rpsSnapshot";

/** Initialize missing derived fields only. No provider calls, scoring, orders, or messages. */
async function main() {
  const args = process.argv.slice(2);
  const rootArg =
    args.find((a) => a.startsWith("--root="))?.slice(7) ||
    process.env.MARKET_DATA_DIR;
  if (!rootArg)
    throw new Error("请指定 --root=本地行情目录 或 MARKET_DATA_DIR");
  const journalRoot =
    args.find((a) => a.startsWith("--journal-root="))?.slice(15) ||
    process.env.SIGNAL_JOURNAL_DIR;
  if (!journalRoot)
    throw new Error("请指定 --journal-root=本地信号目录 或 SIGNAL_JOURNAL_DIR");
  process.env.SIGNAL_JOURNAL_DIR = path.resolve(journalRoot);
  if (!existsSync(path.join(process.env.SIGNAL_JOURNAL_DIR, "signal-entries")))
    throw new Error("信号留档目录不存在");
  const root = path.resolve(rootArg),
    dir = path.join(root, "snapshots/daily-review");
  const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
  const index = read<ReviewIndex>(path.join(dir, "index.json"));
  const journal = read<JournalArchive>(path.join(dir, "journal.json"));
  const rpsFile = path.join(root, "rps/rps-latest.json");
  const rps = existsSync(rpsFile) ? read<RpsSnapshot>(rpsFile) : null;
  if (
    index.version !== 1 ||
    journal.version !== 1 ||
    !index.dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  )
    throw new Error("复盘索引或信号归档格式无效");
  const sessions = [
    ...new Set([...(rps?.calendar?.sessions ?? []), ...index.dates]),
  ].sort();
  const exits = await readFollowupExits(journal.signals.map((s) => s.id));
  const observedAt = new Date().toISOString();
  const backup = path.join(
    root,
    "backups",
    `before-tomorrow-${observedAt.replace(/[:.]/g, "-")}`,
  );
  const cache = new Map<string, DailyReview>();
  const updated = [];
  for (const date of [...index.dates].sort()) {
    const file = path.join(dir, `${date}.json`),
      original = read<DailyReview>(file);
    if (original.version !== 1 || original.date !== date)
      throw new Error(`复盘日期无效：${date}`);
    if (original.followup && original.tomorrow) {
      cache.set(date, original);
      continue;
    }
    const previous = original.previousDate
      ? (cache.get(original.previousDate) ?? null)
      : null;
    const derived = { ...original, builtAt: observedAt };
    derived.followup ??= buildFollowup({
      review: derived,
      signals: journalAsOf(journal.signals, date),
      rps,
      exits: exits.exits,
      previous: previous?.followup,
      sessions,
      basis: "reconstructed",
      exitReadFailed: exits.failed,
    });
    derived.tomorrow ??= buildTomorrowMap(
      derived,
      previous,
      sessions.find((d) => d > date) ?? null,
      "reconstructed",
    );
    const result = {
      ...original,
      followup: derived.followup,
      tomorrow: derived.tomorrow,
    };
    cache.set(date, result);
    if (args.includes("--write")) {
      mkdirSync(backup, { recursive: true });
      copyFileSync(file, path.join(backup, `${date}.json`));
      const followupFile = path.join(dir, "followups", `${date}.json`);
      if (existsSync(followupFile))
        copyFileSync(followupFile, path.join(backup, `${date}.followup.json`));
      writeJsonAtomic(followupFile, result.followup);
      writeJsonAtomic(file, result);
    }
    updated.push({
      date,
      focus: result.tomorrow.events.map((e) => e.title),
      followupRows: result.followup.rows.length,
    });
  }
  console.log(
    JSON.stringify(
      {
        mode: args.includes("--write") ? "write" : "dry-run",
        backup: args.includes("--write") && updated.length ? backup : null,
        updated,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "初始化失败");
  process.exitCode = 1;
});
