import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { snapshotFile, writeSnapshot } from "@/lib/vps/snapshot";
import {
  listLiveBookVersions,
  readLiveBookVersion,
} from "@/lib/fund/liveBooksStore";
import type { LiveBookCache } from "@/lib/fund/liveBooksLogic";
import type { GexSnapshot } from "@/lib/discord/gexCopy";
import { quoteDay } from "./market";
import { reviewAccounts } from "./accounts";
import type { ReviewAccount } from "./types";

/** 原始抓取脚本已有按抓取时间留档；按实际报价日归档，不能按抓取机器的日期归档。 */
export function historicalGex(
  date: string,
  latest: GexSnapshot | null,
): GexSnapshot | null {
  const file = snapshotFile(`gex-history/${date}`);
  const stored = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as GexSnapshot)
    : null;
  const sourceDir =
    process.env.GEX_HISTORY_DIR || path.join(process.cwd(), ".cache/gex");
  let candidate = latest?.items?.some((i) => quoteDay(i.as_of) === date)
    ? latest
    : stored;
  if (!candidate && existsSync(sourceDir)) {
    // 只寻找这一报价日及其之后几日的抓取文件，避免每天遍历全部历史文件内容。
    const start = date.replaceAll("-", "");
    const end = new Date(`${date}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 5);
    const stop = end.toISOString().slice(0, 10).replaceAll("-", "");
    const names = readdirSync(sourceDir)
      .filter(
        (n) =>
          /^gex-\d{8}-\d{4}\.json$/.test(n) &&
          n.slice(4, 12) >= start &&
          n.slice(4, 12) <= stop,
      )
      .sort()
      .reverse();
    for (const name of names) {
      const value = JSON.parse(
        readFileSync(path.join(sourceDir, name), "utf8"),
      ) as GexSnapshot;
      if (value.items?.some((i) => quoteDay(i.as_of) === date)) {
        candidate = value;
        break;
      }
    }
  }
  if (!candidate) return null;
  const snapshot: GexSnapshot = {
    ...candidate,
    items: candidate.items
      .filter((i) => quoteDay(i.as_of) === date)
      .map((i) => ({ ...i })),
  };
  writeSnapshot(`gex-history/${date}`, snapshot);
  return snapshot;
}

/** 从已有不可变账本版本找当天持仓，不回测生成过去持仓。 */
export async function accountHistory(
  dates: string[],
  sessions: string[],
): Promise<Map<string, ReviewAccount[]>> {
  const versions = await listLiveBookVersions();
  const loaded = new Map<string, LiveBookCache | null>(),
    result = new Map<string, ReviewAccount[]>();
  for (const date of dates) {
    const rows: ReviewAccount[] = [];
    for (const tf of ["2h", "4h"] as const) {
      const version = versions.find((v) =>
        v.books.some((b) => b.tf === tf && b.asOf.slice(0, 10) === date),
      );
      if (!version) continue;
      if (!loaded.has(version.id))
        loaded.set(version.id, await readLiveBookVersion(version.id));
      const account = reviewAccounts(
        loaded.get(version.id)!,
        date,
        sessions[sessions.indexOf(date) - 1] ?? null,
        [],
        sessions,
      ).find((a) => a.tf === tf);
      if (account?.holdings != null) rows.push(account);
    }
    result.set(date, rows);
  }
  return result;
}
