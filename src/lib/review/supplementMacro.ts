import { refreshReviewMacro } from "@/lib/data-sources/reviewMacro";
import { lastSettledSession } from "@/lib/backtest/mergeBars";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { readRpsSnapshot } from "@/lib/backtest/rpsSnapshot";
import { loadDailyBars } from "@/lib/vps/loadDailyBars";
import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";
import { macroEnvironment, MACRO_SERIES, type MacroEnvironment } from "./macro";
import { reviewSessions } from "./market";
import { validReviewDate } from "./store";
import type { DailyReview, MarketContext, ReviewIndex } from "./types";

const WARNING = "宏观环境关键数据不足或过期；内部市场状态仍独立计算。";
const incomplete = (m?: MacroEnvironment) =>
  !m ||
  m.regime === "Unknown" ||
  m.rows.length !== MACRO_SERIES.length ||
  m.rows.some((r) => r.status !== "current" || r.change == null);

// 抓取时间变化不等于新数据；仅因 fetchedAt 更新不重写复盘。
function content(m: MacroEnvironment) {
  return JSON.stringify({
    regime: m.regime,
    effectiveDate: m.effectiveDate,
    evidence: m.evidence,
    rows: m.rows.map(({ fetchedAt: _fetchedAt, ...row }) => row),
  });
}

/** 只补最近五份已发布复盘的宏观缺项，不重算账户、信号或期权结构。 */
export async function supplementMacroReviews() {
  if (marketBaseUrl()) throw new Error("宏观补采必须在本地行情存储上运行");
  const until = lastSettledSession();
  const index = await readSnapshot<ReviewIndex>("daily-review/index");
  const result = {
    until,
    checked: [] as string[],
    updated: [] as string[],
    unresolved: [] as string[],
    errors: [] as string[],
  };
  if (!index) return result;
  if (
    index.version !== 1 ||
    !Array.isArray(index.dates) ||
    !index.dates.every(validReviewDate)
  )
    throw new Error("复盘索引无效");
  const candidates: DailyReview[] = [];
  for (const date of [...index.dates]
    .filter((d) => d <= until)
    .sort()
    .reverse()
    .slice(0, 5)) {
    const review = await readSnapshot<DailyReview>(`daily-review/${date}`);
    if (!review || review.version !== 1 || review.date !== date)
      throw new Error(`复盘归档无效：${date}`);
    if (incomplete(review.market.macro)) candidates.push(review);
  }
  if (!candidates.length) return result;
  const bars = await loadDailyBars(["SPY"]);
  const sessions = reviewSessions(
    bars.get("SPY")?.map((r) => r.date) ?? [],
    readRpsSnapshot()?.calendar,
  );
  if (candidates.some((r) => !sessions.includes(r.date)))
    throw new Error("缺少对应交易日历");
  const archive = await refreshReviewMacro(until);
  result.errors = archive.errors;
  const builtAt = new Date().toISOString();
  for (const review of candidates) {
    result.checked.push(review.date);
    const macro = macroEnvironment(
      archive,
      review.date,
      sessions,
      builtAt,
      review.date < until || review.market.macro?.basis === "reconstructed",
    );
    if (incomplete(macro)) result.unresolved.push(review.date);
    const old = review.market.macro;
    // 断源或损坏的归档不能抹去网页已有的观测。
    if (
      old?.rows.some(
        (r) =>
          r.value != null &&
          !macro.rows.some(
            (n) =>
              n.id === r.id &&
              n.value != null &&
              n.observationDate! >= r.observationDate!,
          ),
      )
    ) {
      result.errors.push(`${review.date}: 新宏观数据不完整，保留原复盘`);
      continue;
    }
    if (old && content(old) === content(macro)) continue;
    const warnings = review.warnings.filter((w) => w !== WARNING);
    if (macro.regime === "Unknown") warnings.push(WARNING);
    writeSnapshot(`daily-review/${review.date}`, {
      ...review,
      builtAt,
      market: { ...review.market, macro },
      warnings,
      publishedMarket: review.publishedMarket ?? {
        builtAt: review.builtAt,
        market: review.market,
      },
    } satisfies DailyReview);
    result.updated.push(review.date);
    if (review.date === index.latest) {
      const context = await readSnapshot<MarketContext & { builtAt: string }>(
        "daily-review/context",
      );
      if (
        context?.date === review.date &&
        context.regime === review.market.regime &&
        JSON.stringify(context.engine) === JSON.stringify(review.market.engine)
      )
        writeSnapshot("daily-review/context", { ...context, builtAt, macro });
    }
  }
  if (result.updated.length)
    writeSnapshot("daily-review/index", { ...index, updatedAt: builtAt });
  return result;
}
