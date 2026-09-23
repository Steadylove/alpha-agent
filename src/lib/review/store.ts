import { readFileSync, existsSync } from "node:fs";
import { snapshotFile, readSnapshot } from "@/lib/vps/snapshot";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import type {
  DailyReview,
  JournalArchive,
  ReviewIndex,
  MarketContext,
} from "./types";
import { journalAsOf } from "./journal";

export const validReviewDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export function localReview<T>(name: string): T | null {
  const file = snapshotFile(`daily-review/${name}`);
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as T)
    : null;
}
async function read<T>(name: string): Promise<T | null> {
  // 远程失效不回退到构建机上的旧行情。
  if (marketBaseUrl()) {
    const text = await fetchMarketText(
      `snapshots/daily-review/${name}.json`,
      AbortSignal.timeout(8000),
    );
    return text.trim() ? (JSON.parse(text) as T) : null;
  }
  return readSnapshot<T>(`daily-review/${name}`);
}
export async function getReviewData(requested?: string) {
  let index: ReviewIndex | null = null;
  try {
    index = await read<ReviewIndex>("index");
    if (
      !index ||
      index.version !== 1 ||
      !Array.isArray(index.dates) ||
      !index.dates.every(validReviewDate)
    )
      return {
        review: null,
        dates: [],
        journal: [],
        error: "每日复盘尚未生成。收盘任务完成后，这里会显示真实行情与信号。",
      };
    const date = requested ?? index.latest;
    if (!validReviewDate(date) || !index.dates.includes(date))
      return {
        review: null,
        dates: index.dates,
        journal: [],
        error: "该日期还没有复盘归档，请选择已发布的交易日。",
      };
    const review = await read<DailyReview>(date);
    if (review?.version !== 1 || review.date !== date)
      throw new Error("invalid review");
    let journal: JournalArchive | null = null;
    let error: string | null = null;
    try {
      journal = await read<JournalArchive>("journal");
    } catch {
      error = "信号跟踪暂时无法读取，今日复盘仍可查看。";
    }
    return {
      review,
      dates: index.dates,
      journal: journalAsOf(journal?.signals ?? review.signals, date),
      error,
    };
  } catch {
    return {
      review: null,
      dates: index?.dates ?? [],
      journal: [],
      error: "复盘数据服务暂时不可用，请稍后重试。",
    };
  }
}

export async function marketContextBefore(
  stamp: number,
  expectedDate?: string,
): Promise<
  | NonNullable<
      import("@/lib/signals/assessment").EntrySnapshot["marketContext"]
    >
  | undefined
> {
  try {
    const context = await readSnapshot<MarketContext & { builtAt: string }>(
      "daily-review/context",
      AbortSignal.timeout(1200),
    );
    if (
      context &&
      validReviewDate(context.date) &&
      context.date === expectedDate &&
      Date.parse(context.builtAt) <= stamp &&
      context.regime !== "Unknown"
    ) {
      return {
        regime: context.regime,
        date: context.date,
        ...(context.engine ? { engine: context.engine } : {}),
        ...(context.macro ? { macro: context.macro } : {}),
      };
    }
  } catch {
    /* 不为市场上下文阻断告警；缺失保留为缺失。 */
  }
  return undefined;
}
