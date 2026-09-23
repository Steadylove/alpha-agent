import { macroEnvironment, type MacroArchive } from "./macro";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { marketDataRoot } from "@/lib/backtest/marketStore";
import { lastSettledNyDate } from "@/lib/backtest/mergeBars";
import { ensureRpsSnapshot } from "@/lib/backtest/rpsSnapshot";
import { readLiveBooks } from "@/lib/fund/liveBooksStore";
import { readDeskJson } from "@/lib/fund/deskRemote";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { loadDailyBars } from "@/lib/vps/loadDailyBars";
import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import {
  fetchAlpacaDailyBars,
  hasAlpacaCredentials,
} from "@/lib/data-sources/alpaca";
import type { EntrySnapshot } from "@/lib/signals/assessment";
import { tradeIdOf } from "@/lib/signals/journal";
import type { GexSnapshot } from "@/lib/discord/gexCopy";
import {
  REVIEW_INDICES,
  REVIEW_SECTORS,
  sectorStrength,
  marketReview,
  optionsMap,
  reviewSessions,
  type Bars,
} from "./market";
import {
  evaluateEntry,
  reviewTf,
  signalDay,
  mergeEvaluation,
  journalAsOf,
  type EvaluationPrices,
} from "./journal";
import { reviewAccounts } from "./accounts";
import { localReview, validReviewDate } from "./store";
import type { DailyReview, JournalArchive, ReviewIndex } from "./types";
import { historicalGex, accountHistory } from "./history";

/** 只收录真实 journal 目录，绝不扫描 previews / research 并冒充实时信号。 */
async function entries(): Promise<EntrySnapshot[]> {
  const dir = path.join(
    process.env.SIGNAL_JOURNAL_DIR ||
      path.join(process.cwd(), ".cache/signal-journal"),
    "signal-entries",
  );
  let raw: unknown[] = [];
  if (!process.env.SIGNAL_JOURNAL_DIR && marketBaseUrl()) {
    const ids = await readDeskJson(
      "signal-entry-index.json",
      AbortSignal.timeout(8000),
    );
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    )
      throw new Error("信号目录无效");
    for (let i = 0; i < ids.length; i += 12)
      raw.push(
        ...(await Promise.all(
          ids
            .slice(i, i + 12)
            .map((id) =>
              readDeskJson(
                `signal-entries/${id}.json`,
                AbortSignal.timeout(8000),
              ),
            ),
        )),
      );
  } else if (existsSync(dir)) {
    raw = readdirSync(dir)
      .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
  }
  const records = raw as EntrySnapshot[];
  if (
    records.some(
      (e) =>
        !e?.payload ||
        e.version !== 1 ||
        tradeIdOf(e.payload) !== e.id ||
        !e.quality ||
        !Array.isArray(e.quality.dimensions),
    )
  )
    throw new Error("信号归档存在无效记录");
  return records.filter((e) => reviewTf(e.payload.tf) != null);
}

type PriceCache = EvaluationPrices & { fetchedFor: string; from: string };
async function evaluationPrices(
  symbol: string,
  from: string,
  date: string,
): Promise<PriceCache | null> {
  if (!/^[A-Z0-9.^-]{1,16}$/.test(symbol)) return null;
  const root = marketDataRoot() ?? path.join(process.cwd(), "data");
  const file = path.join(root, "review-prices", `${symbol}.json`);
  const cached: PriceCache | null = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : null;
  if (cached && cached.from <= from && cached.fetchedFor >= date) return cached;
  if (!hasAlpacaCredentials()) return cached;
  const start = `${cached && cached.from < from ? cached.from : from}T00:00:00Z`;
  const [raw, split] = await Promise.all([
    fetchAlpacaDailyBars(symbol, start, "raw"),
    fetchAlpacaDailyBars(symbol, start, "split"),
  ]);
  const result = { raw, split, from: start.slice(0, 10), fetchedFor: date };
  writeJsonAtomic(file, result);
  return result;
}

export async function buildDailyReview(
  requested?: string,
): Promise<DailyReview> {
  if (requested && !validReviewDate(requested))
    throw new Error("日期必须为 YYYY-MM-DD");
  const warnings: string[] = [];
  const safe = async <T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch {
      warnings.push(`${label}读取失败，相关数据保留为缺失。`);
      return null;
    }
  };
  const [rps, cache, signals, gex] = await Promise.all([
    safe("RPS / 成分名单", ensureRpsSnapshot),
    safe("策略账本", readLiveBooks),
    safe("信号档案", entries),
    safe(
      "Gamma 快照",
      async () =>
        (await readSnapshot<GexSnapshot>("gex")) ??
        (existsSync(".cache/gex/latest.json")
          ? (JSON.parse(
              readFileSync(".cache/gex/latest.json", "utf8"),
            ) as GexSnapshot)
          : null),
    ),
  ]);
  const members = Object.keys(rps?.sector?.classification ?? {}).filter(
    (s) => !rps?.sector?.classificationEvidence?.[s],
  );
  if (!members.length)
    warnings.push("缺少有来源的标普成分名单，市场上涨比例暂缺。");
  const symbols = [
    ...new Set([
      ...REVIEW_INDICES,
      ...REVIEW_SECTORS.map((s) => s.symbol),
      ...members,
    ]),
  ];
  const bars: Bars = new Map();
  for (let i = 0; i < symbols.length; i += 16) {
    const chunks = await Promise.all(
      symbols
        .slice(i, i + 16)
        .map((s) =>
          safe(`${s} 日线`, () =>
            loadDailyBars([s], AbortSignal.timeout(12000)),
          ),
        ),
    );
    for (const chunk of chunks)
      for (const [symbol, rows] of chunk ?? []) bars.set(symbol, rows);
  }
  const settled = lastSettledNyDate();
  const spyDates =
    bars
      .get("SPY")
      ?.map((b) => b.date)
      .filter((d) => d <= settled) ?? [];
  const date = requested ?? spyDates.at(-1);
  if (!date || !spyDates.includes(date))
    throw new Error("没有该交易日已收盘的 SPY 日线，不能生成复盘");
  const sessions = reviewSessions(spyDates, rps?.calendar);
  const previousDate = sessions[sessions.indexOf(date) - 1] ?? null;
  const previous = previousDate ? localReview<DailyReview>(previousDate) : null;
  const existing = localReview<DailyReview>(date);
  const sectors = sectorStrength(bars, sessions, date),
    previousSectors = previousDate
      ? sectorStrength(bars, sessions, previousDate)
      : [];
  const oldJournal = localReview<JournalArchive>("journal");
  const journal = new Map((oldJournal?.signals ?? []).map((s) => [s.id, s]));
  const relevant = (signals ?? []).filter(
    (e) =>
      signalDay(e.payload.entrySignalTime!) <= date &&
      signalDay(Date.parse(e.capturedAt)) <= date,
  );
  const needing = relevant.filter(
    (e) =>
      journal.get(e.id)?.outcomes.t5.status !== "ready" ||
      journal.get(e.id)?.excursions.at(-1)?.mae == null,
  );
  const bySymbol = new Map<string, EntrySnapshot[]>();
  for (const e of needing) {
    const symbol = e.payload.symbol
      .slice(e.payload.symbol.lastIndexOf(":") + 1)
      .toUpperCase();
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), e]);
  }
  for (const [symbol, list] of bySymbol) {
    const from = list
      .map((e) => signalDay(e.payload.entrySignalTime!))
      .sort()[0];
    const prices = await safe(`${symbol} 信号原始/拆股日线`, () =>
      evaluationPrices(symbol, from, date),
    );
    for (const entry of list) {
      const result = evaluateEntry(entry, sessions, prices, date);
      if (result)
        journal.set(result.id, mergeEvaluation(journal.get(result.id), result));
    }
  }
  if (bySymbol.size && !hasAlpacaCredentials())
    warnings.push("未配置原始/拆股行情来源；缺少缓存的信号收益暂不计算。");
  const allSignals = [...journal.values()].sort(
    (a, b) => b.signalTime - a.signalTime || a.id.localeCompare(b.id),
  );
  const currentGex = await safe("当日 Gamma 归档", async () =>
    historicalGex(date, gex),
  );
  const priorGex = previousDate
    ? await safe("前日 Gamma 归档", async () =>
        historicalGex(previousDate, gex),
      )
    : null;
  const fromGex =
    priorGex && previousDate
      ? optionsMap(priorGex, [], previousDate, null)
      : [];
  const previousOptions = ["SPX", "SPY", "QQQ", "IWM"].flatMap((symbol) => {
    const row =
      previous?.options.find((r) => r.symbol === symbol && r.today) ??
      fromGex.find((r) => r.symbol === symbol);
    return row ? [row] : [];
  });
  const options = optionsMap(currentGex, previousOptions, date, previousDate);
  // 重跑旧交易日不允许用今天的期权链替换已保存的当日期权结构。
  for (const row of options)
    if (!row.today) {
      const saved = existing?.options.find(
        (r) => r.symbol === row.symbol && r.today,
      );
      if (saved) Object.assign(row, saved);
    }
  if (options.some((r) => !r.today))
    warnings.push("部分 Gamma 数据缺少当日快照，未使用其他交易日的价位代替。");
  const needHistory = [
    ...new Set([
      ...(previousDate &&
      previous?.accounts.every((a) => a.holdings != null) !== true
        ? [previousDate]
        : []),
      ...(cache?.books.every((b) => b.view.asOf.slice(0, 10) === date) !== true
        ? [date]
        : []),
    ]),
  ];
  const history = needHistory.length
    ? await safe("历史账本", () => accountHistory(needHistory, sessions))
    : null;
  const priorAccounts = (["2h", "4h"] as const).flatMap((tf) => {
    const row =
      previous?.accounts.find((a) => a.tf === tf && a.holdings != null) ??
      history?.get(previousDate ?? "")?.find((a) => a.tf === tf);
    return row ? [row] : [];
  });
  const accounts = reviewAccounts(
    cache,
    date,
    previousDate,
    priorAccounts,
    sessions,
  );
  for (let i = 0; i < accounts.length; i++)
    if (accounts[i].holdings == null) {
      const saved =
        existing?.accounts.find(
          (a) => a.tf === accounts[i].tf && a.holdings != null,
        ) ?? history?.get(date)?.find((a) => a.tf === accounts[i].tf);
      if (saved) accounts[i] = saved;
    }
  const builtAt = new Date().toISOString();
  const market = marketReview(
    bars,
    sessions,
    date,
    members,
    rps?.sector?.membershipAsOf ?? null,
    sectors,
    previousSectors,
  );
  const reconstructed =
    date < settled ||
    date !== spyDates.at(-1) ||
    existing?.market.engine?.basis === "reconstructed" ||
    (!!existing && existing.market.engine?.version !== market.engine?.version);
  if (market.engine)
    market.engine.basis = reconstructed ? "reconstructed" : "daily";
  const macroArchive = await safe("宏观观测", () =>
    readSnapshot<MacroArchive>("macro-observations"),
  );
  market.macro = macroEnvironment(
    macroArchive,
    date,
    sessions,
    builtAt,
    reconstructed,
  );
  if (market.macro.regime === "Unknown")
    warnings.push("宏观环境关键数据不足或过期；内部市场状态仍独立计算。");
  const result: DailyReview = {
    version: 1,
    date,
    previousDate,
    builtAt,
    market,
    ...(existing
      ? {
          publishedMarket: existing.publishedMarket ?? {
            builtAt: existing.builtAt,
            market: existing.market,
          },
        }
      : {}),
    sectors,
    options,
    accounts,
    signals: journalAsOf(
      allSignals.filter((s) => s.date === date),
      date,
    ),
    warnings,
  };
  writeSnapshot(`daily-review/${date}`, result);
  // 不允许重跑早期日期使最新 journal 的成熟结果回退。
  if (!oldJournal || oldJournal.asOf <= date)
    writeSnapshot("daily-review/journal", {
      version: 1,
      asOf: date,
      builtAt: result.builtAt,
      signals: allSignals,
    } satisfies JournalArchive);
  const index = localReview<ReviewIndex>("index");
  const dates = [...new Set([...(index?.dates ?? []), date])].sort().reverse();
  writeSnapshot("daily-review/index", {
    version: 1,
    latest: dates[0],
    dates,
    updatedAt: result.builtAt,
  } satisfies ReviewIndex);
  if (date === dates[0] && date === spyDates.at(-1))
    writeSnapshot("daily-review/context", {
      date,
      builtAt: result.builtAt,
      regime: result.market.regime,
      engine: result.market.engine,
      macro: result.market.macro,
    });
  return result;
}
