import { fetchFmpValuationInputs } from "@/lib/data-sources/fmp";
import { fetchYahoo1HBars, aggregateTo4H } from "@/lib/data-sources/yahooIntraday";
import { getPrisma } from "@/lib/db/prisma";
import { computeMomentumGates, fourHourAlpha } from "@/lib/scoring/momentumGates";
import { relativeRsSeries } from "@/lib/scoring/relativeRs";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { atrSeries, emaSeries, smaOfNullable } from "@/lib/scoring/series";
import { type StockStage, computeStockStageSeries } from "@/lib/scoring/stockStage";
import { computeValuation, shortTermTarget } from "@/lib/scoring/valuation12m";

/**
 * 每日重算 12M 估值目标。
 *
 * 只算最新一天——基本面是当期值，见 `StockValuation` 的模型注释。
 *
 * 基本面走 `StockFundamentals` 缓存，超过 `FUNDAMENTALS_TTL_DAYS` 才回源。
 * FMP 免费额度 250 次/天，每只标的一次刷新要 4 次调用，40 只就是 160 次；
 * 季报一年只变四次，按周刷新既够用又不会把额度打满。
 */

const BENCHMARK_SYMBOL = "SPY";
const MIN_BARS = 900;
const FUNDAMENTALS_TTL_DAYS = 7;

export type StockValuationJobResult = {
  latestDate: string | null;
  symbolsEvaluated: number;
  fundamentalsRefreshed: number;
  fundamentalsMissing: string[];
  fourHourMissing: string[];
  rowsWritten: number;
};

type ValuationBar = { date: string; high: number; low: number; close: number; volume: number };

type CachedFundamentals = {
  epsTtm: number | null;
  revTtm: number | null;
  sharesOutstanding: number | null;
  marketCap: number | null;
  epsQYoY: number | null;
  analystTarget: number | null;
  analystCount: number;
};

/**
 * 按需刷新基本面缓存。
 *
 * FMP 额度耗尽时会整片返回 429，`fetchFmpValuationInputs` 里的 safeJson 把它吞成 null。
 * 这里的处理是保留旧缓存继续用，只把「从来没取到过」的标的记进 missing——
 * 宁可用上周的季报，也不要因为额度问题让整个面板空掉。
 */
async function loadFundamentals(
  symbols: string[],
): Promise<{ bySymbol: Map<string, CachedFundamentals>; refreshed: number; missing: string[] }> {
  const prisma = getPrisma();
  const cached = await prisma.stockFundamentals.findMany({
    where: { symbol: { in: symbols } },
  });
  const bySymbol = new Map<string, CachedFundamentals>();
  const cacheRow = new Map(cached.map((c) => [c.symbol, c]));

  const staleBefore = new Date(Date.now() - FUNDAMENTALS_TTL_DAYS * 24 * 60 * 60 * 1000);
  let refreshed = 0;
  const missing: string[] = [];

  for (const symbol of symbols) {
    const row = cacheRow.get(symbol);
    const isFresh = row != null && row.fetchedAt > staleBefore;

    if (!isFresh) {
      const fetched = await fetchFmpValuationInputs(symbol);
      if (fetched) {
        await prisma.stockFundamentals.upsert({
          where: { symbol },
          update: { ...fetched, fetchedAt: new Date() },
          create: { ...fetched, fetchedAt: new Date() },
        });
        bySymbol.set(symbol, fetched);
        refreshed += 1;
        continue;
      }
    }

    if (row) bySymbol.set(symbol, row);
    else missing.push(symbol);
  }

  return { bySymbol, refreshed, missing };
}

/** 4H 相对 alpha，任一环节失败即记 null——它只是超级动能四个条件之一。 */
async function loadFourHourAlpha(
  symbols: string[],
): Promise<{ bySymbol: Map<string, number>; missing: string[] }> {
  const bySymbol = new Map<string, number>();
  const missing: string[] = [];

  let benchmark: number[];
  try {
    benchmark = aggregateTo4H(await fetchYahoo1HBars(BENCHMARK_SYMBOL)).map((b) => b.close);
  } catch {
    return { bySymbol, missing: [...symbols] };
  }

  for (const symbol of symbols) {
    try {
      const bars = aggregateTo4H(await fetchYahoo1HBars(symbol)).map((b) => b.close);
      const n = Math.min(bars.length, benchmark.length);
      const alpha = fourHourAlpha(bars.slice(-n), benchmark.slice(-n));
      if (alpha == null) missing.push(symbol);
      else bySymbol.set(symbol, alpha);
    } catch {
      missing.push(symbol);
    }
  }

  return { bySymbol, missing };
}

async function loadBars(symbols: string[]): Promise<Map<string, ValuationBar[]>> {
  const prisma = getPrisma();
  const instruments = await prisma.instrument.findMany({
    where: { symbol: { in: symbols } },
    select: { id: true, symbol: true },
  });

  const rows = await prisma.dailyBar.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) } },
    orderBy: { date: "asc" },
    select: {
      instrumentId: true,
      date: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });

  const symbolById = new Map(instruments.map((i) => [i.id, i.symbol]));
  const bySymbol = new Map<string, ValuationBar[]>();
  for (const row of rows) {
    const symbol = symbolById.get(row.instrumentId);
    if (!symbol) continue;
    const list = bySymbol.get(symbol) ?? [];
    list.push({
      date: row.date.toISOString().slice(0, 10),
      high: row.high,
      low: row.low,
      close: row.close,
      volume: Number(row.volume ?? 0),
    });
    bySymbol.set(symbol, list);
  }
  return bySymbol;
}

export async function runStockValuationJob(): Promise<StockValuationJobResult> {
  const prisma = getPrisma();
  const startedAt = new Date();
  let rowsWritten = 0;

  try {
    const symbols = ROTATION_UNIVERSE.map((t) => t.symbol);
    const bySymbol = await loadBars([...symbols, BENCHMARK_SYMBOL]);

    const benchBars = bySymbol.get(BENCHMARK_SYMBOL);
    if (!benchBars || benchBars.length < MIN_BARS) {
      throw new Error(`基准 ${BENCHMARK_SYMBOL} 数据不足，请先执行 npm run backfill:rotation`);
    }
    const benchByDate = new Map(benchBars.map((b) => [b.date, b.close]));

    const eligible = symbols.filter((s) => (bySymbol.get(s)?.length ?? 0) >= MIN_BARS);

    const [fundamentals, fourHour] = await Promise.all([
      loadFundamentals(eligible),
      loadFourHourAlpha(eligible),
    ]);

    const latestPhase = await prisma.macroPhaseState.findFirst({
      orderBy: { date: "desc" },
      select: { pathId: true, fsmState: true },
    });
    const pathId = latestPhase?.pathId ?? 0;
    const fsmState = latestPhase?.fsmState ?? 1;

    const rows: {
      date: Date;
      symbol: string;
      close: number;
      primaryTarget: number;
      upsidePct: number;
      mode: string;
      consensusSmoothed: boolean;
      archetype: string;
      currentPe: number | null;
      calculatedPe: number | null;
      marketCapB: number | null;
      isDipActive: boolean;
      shortTermTarget: number;
      squeezeTier: string;
      isInLongDowntrend: boolean;
      isHyperMomentum: boolean;
      tfAlpha: number | null;
    }[] = [];
    let latestDate: string | null = null;

    for (const symbol of eligible) {
      const raw = bySymbol.get(symbol)!;
      const bars = raw.filter((b) => benchByDate.has(b.date));
      if (bars.length < MIN_BARS) continue;

      const closes = bars.map((b) => b.close);
      const bench = bars.map((b) => benchByDate.get(b.date)!);
      const rs = relativeRsSeries(closes, bench);
      const stages = computeStockStageSeries(bars, rs);

      const ema200 = emaSeries(closes, 200);
      const ema850 = emaSeries(closes, 850);
      const atr252 = smaOfNullable(atrSeries(bars, 14), 252);

      const i = bars.length - 1;
      const last = bars[i];
      if (latestDate == null || last.date > latestDate) latestDate = last.date;

      const tfAlpha = fourHour.bySymbol.get(symbol) ?? null;
      const gates = computeMomentumGates({
        closes,
        rsRatings: rs,
        index: i,
        tfAlpha,
        ema200: ema200[i],
        ema850: ema850[i],
      });

      const f = fundamentals.bySymbol.get(symbol);
      const verdict = computeValuation({
        close: last.close,
        atr: atr252[i] ?? 0,
        ema200: ema200[i],
        trendScore: stages[i].trendScore,
        rs: rs[i],
        stage: stages[i].stage as StockStage,
        isInLongDowntrend: gates.isInLongDowntrend,
        isHyperMomentum: gates.isHyperMomentum,
        fsmState,
        pathId,
        epsTtm: f?.epsTtm ?? null,
        revTtm: f?.revTtm ?? null,
        sharesOutstanding: f?.sharesOutstanding ?? null,
        marketCap: f?.marketCap ?? null,
        epsQYoY: f?.epsQYoY ?? null,
        analystTarget: f?.analystTarget ?? null,
        analystCount: f?.analystCount ?? 0,
      });

      const shortTerm = shortTermTarget(last.close, atr252[i] ?? 0, null, f?.sharesOutstanding ?? null);

      rows.push({
        date: new Date(`${last.date}T00:00:00.000Z`),
        symbol,
        close: last.close,
        primaryTarget: verdict.primaryTarget,
        upsidePct: verdict.upsidePct,
        mode: verdict.mode,
        consensusSmoothed: verdict.consensusSmoothed,
        archetype: verdict.archetype,
        currentPe: verdict.currentPe,
        calculatedPe: verdict.calculatedPe,
        marketCapB: verdict.marketCapB,
        isDipActive: verdict.isDipActive,
        // short interest 无可用数据源，恒走 Pine 的 na 兜底，详见 shortTermTarget 注释
        shortTermTarget: shortTerm.target,
        squeezeTier: shortTerm.tier,
        isInLongDowntrend: gates.isInLongDowntrend,
        isHyperMomentum: gates.isHyperMomentum,
        tfAlpha,
      });
    }

    if (rows.length === 0) {
      throw new Error("无可用标的，请先执行 npm run backfill:rotation");
    }

    await prisma.$transaction(
      [
        prisma.stockValuation.deleteMany({ where: { date: rows[0].date } }),
        prisma.stockValuation.createMany({ data: rows }),
      ],
      { timeout: 60_000 },
    );
    rowsWritten = rows.length;

    const finishedAt = new Date();
    const result: StockValuationJobResult = {
      latestDate,
      symbolsEvaluated: rows.length,
      fundamentalsRefreshed: fundamentals.refreshed,
      fundamentalsMissing: fundamentals.missing,
      fourHourMissing: fourHour.missing,
      rowsWritten,
    };

    await prisma.jobRun.create({
      data: {
        name: "stock-valuation",
        status: "SUCCESS",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        recordsWritten: rowsWritten,
        details: { ...result },
      },
    });

    return result;
  } catch (error) {
    const finishedAt = new Date();
    await prisma.jobRun.create({
      data: {
        name: "stock-valuation",
        status: "FAILED",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        recordsWritten: rowsWritten,
        error: error instanceof Error ? error.message : String(error),
        details: {},
      },
    });
    throw error;
  }
}
