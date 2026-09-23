import type { RpsCalendar } from "@/lib/backtest/rpsSnapshot";
import { lastSettledNyDate } from "@/lib/backtest/mergeBars";
import {
  OPTION_SYMBOLS,
  freezeOptionsContext,
  quoteTimestamp,
  type OptionsPublication,
} from "@/lib/options/signalContext";
import {
  finiteOption,
  optionsStructure,
  type GexSnapshot,
} from "@/lib/options/structure";
import { REVIEW_INDICES, REVIEW_SECTORS, quoteDay } from "./market";
import type { DailyReview, JournalArchive, ReviewIndex } from "./types";

export type HealthIssues = { errors: string[]; warnings: string[] };

/** Use the same 20-minute availability delay as the daily price collector, with the real calendar. */
export function expectedReviewSession(
  calendar: RpsCalendar | undefined,
  now = new Date(),
) {
  const settled = lastSettledNyDate(new Date(now.getTime() - 20 * 60_000));
  const days = calendar?.sessions;
  if (
    !calendar ||
    calendar.from > settled ||
    calendar.through < settled ||
    !days?.length ||
    days.some(
      (d, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        d < calendar.from ||
        d > calendar.through ||
        (i > 0 && d <= days[i - 1]),
    )
  )
    throw new Error("交易日历缺失、过期或无效");
  const latest = days.filter((d) => d <= settled).at(-1);
  const index = latest ? days.indexOf(latest) : -1;
  if (index < 0 || !days[index + 1])
    throw new Error("交易日历未覆盖已收盘日及下一交易日");
  return { date: days[index], next: days[index + 1] };
}

export function gexHealth(
  snapshot: GexSnapshot | null,
  date: string,
  now = new Date(),
): HealthIssues {
  const errors: string[] = [],
    warnings: string[] = [];
  if (
    !snapshot?.source ||
    !snapshot.method ||
    !snapshot.method_version ||
    !snapshot.dte
  )
    errors.push("Gamma 来源、方法版本或 DTE 缺失");
  const fetched = Date.parse(snapshot?.fetched_at ?? "");
  if (!Number.isFinite(fetched) || fetched > now.getTime())
    errors.push("Gamma 抓取时间无效");
  for (const symbol of OPTION_SYMBOLS) {
    const matches = snapshot?.items?.filter((r) => r.symbol === symbol) ?? [];
    const row = matches[0];
    if (
      matches.length !== 1 ||
      !row ||
      quoteDay(row.as_of) !== date ||
      !finiteOption(row.contracts_used) ||
      row.contracts_used <= 0
    ) {
      errors.push(`${symbol} 缺少 ${date} 的有效期权链`);
      continue;
    }
    const quoted = quoteTimestamp(row.as_of);
    if (quoted == null || quoted > fetched)
      errors.push(`${symbol} 报价时间无效或晚于采集时间`);
    const state = optionsStructure(row);
    if (state.values.spot == null || state.values.net_gex == null)
      errors.push(`${symbol} 现价或 Net GEX 无效`);
    // A valid model can legitimately have no zero-gamma crossing. Do not retry to invent one.
    if (state.flip === "unknown" || state.wall === "unknown")
      warnings.push(`${symbol} 部分结构未知，保留缺失`);
  }
  return { errors, warnings };
}

export function reviewHealth(input: {
  date: string;
  next: string;
  index: ReviewIndex | null;
  review: DailyReview | null;
  journal: JournalArchive | null;
  publication: OptionsPublication | null;
  entryIds: string[];
}): HealthIssues {
  const { date, next, index, review, journal, publication, entryIds } = input;
  const errors: string[] = [],
    warnings: string[] = [];
  if (index?.latest !== date || !index.dates.includes(date))
    errors.push(`复盘索引未更新至 ${date}`);
  if (review?.date !== date) errors.push(`缺少 ${date} 复盘`);
  else {
    for (const symbol of REVIEW_INDICES) {
      const row = review.market.metrics.find((r) => r.symbol === symbol);
      if (!row || ![row.today, row.yesterday, row.change].every(finiteOption))
        errors.push(`${symbol} 指数日线缺失`);
    }
    const b = review.market.breadth;
    if (
      !finiteOption(b.today) ||
      !finiteOption(b.yesterday) ||
      b.total < 100 ||
      b.valid / b.total < 0.95
    )
      errors.push("市场广度覆盖不足");
    for (const { symbol } of REVIEW_SECTORS) {
      const row = review.sectors.find((r) => r.symbol === symbol);
      if (
        !row ||
        ![row.rps, row.d1, row.d5, row.d20, row.change].every(finiteOption)
      )
        errors.push(`${symbol} 板块强度缺项`);
    }
    for (const tf of ["2h", "4h"]) {
      const row = review.accounts.find((r) => r.tf === tf);
      if (
        !row ||
        row.asOf?.slice(0, 10) !== date ||
        ![
          row.equity,
          row.daily,
          row.holdings,
          row.cashPct,
          row.maxWeight,
        ].every(finiteOption)
      )
        errors.push(`${tf} 账户未完整更新`);
      else if (row.monthly == null) warnings.push(`${tf} 月收益缺少月初基准`);
    }
    for (const symbol of OPTION_SYMBOLS) {
      const row = review.options.find((r) => r.symbol === symbol);
      if (
        !row?.today ||
        quoteDay(row.today.as_of) !== date ||
        !row.structure ||
        !row.meta?.method_version
      )
        errors.push(`${symbol} 复盘期权结构未更新`);
    }
    const macro = review.market.macro;
    if (!macro || macro.rows.length !== 7) warnings.push("宏观观测不完整");
    for (const r of macro?.rows ?? [])
      if (r.status !== "current" || r.change == null)
        warnings.push(
          `${r.id} 宏观数据 ${r.status}，截至 ${r.observationDate ?? "未知"}`,
        );
  }
  if (journal?.asOf !== date) errors.push(`信号跟踪未更新至 ${date}`);
  if (journal) {
    const ids = new Set(journal.signals.map((s) => s.id));
    const lost = entryIds.filter((id) => !ids.has(id)).length;
    if (lost) errors.push(`${lost} 条原始买点尚未进入跟踪`);
    for (const s of journal.signals)
      for (const [k, r] of Object.entries(s.outcomes)) {
        if (
          r.date &&
          r.date <= date &&
          (r.status !== "ready" || !finiteOption(r.value))
        )
          errors.push(`${s.symbol} ${k} 应成熟但缺少结果`);
      }
  }
  // Pure validation only. Never store this synthetic validation instant as a real signal.
  const at = Math.max(
    quoteTimestamp(`${next}T09:30:00`) ?? NaN,
    Date.parse(publication?.publishedAt ?? ""),
  );
  const frozen = Number.isFinite(at)
    ? freezeOptionsContext(publication, at, new Date(at).toISOString(), date)
    : null;
  if (!frozen?.publication || publication?.validForSession !== next)
    errors.push("下一交易日期权上下文未发布或时间校验失败");
  else
    for (const item of frozen.publication.items) {
      if (
        !item.raw ||
        !item.dte ||
        !item.structure.provenance.source ||
        !item.structure.provenance.method_version
      )
        errors.push(`${item.symbol} 留档上下文缺少数据或来源版本`);
    }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
