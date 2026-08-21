import { getPrisma } from "@/lib/db/prisma";
import { computeDipZone } from "@/lib/scoring/dipZone";
import { isRsAccelerating, relativeRsSeries } from "@/lib/scoring/relativeRs";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { atrSeries, emaSeries, smaOfNullable } from "@/lib/scoring/series";
import { computeStockRegimeSeries } from "@/lib/scoring/stockRegime";
import { computeStockStageSeries, institutionalVwap } from "@/lib/scoring/stockStage";

/**
 * 每日重算个股深度面板：趋势打分、形态阶段、Hurst / VCP / 资金态、低吸支撑带。
 *
 * 与 rotationRadar 一样全历史重算——筑底天数、EMA576、Hurst 都要连续递推，
 * 且只回写一个窗口的每日状态，让底层日线的回补修正能自愈。
 */

/** 相对强度的基准。Pine 用 SP:SPX，我们只有 SPY，两者日收益率几乎同步。 */
const BENCHMARK_SYMBOL = "SPY";
/** 每日状态回写天数。 */
const UPSERT_DAYS = 180;
/** EMA576 与 sma(atr14, 252) 都需要长预热，短于此数的标的整只跳过。 */
const MIN_BARS = 900;

export type StockPanelJobResult = {
  latestDate: string | null;
  symbolsEvaluated: number;
  symbolsSkipped: string[];
  rowsWritten: number;
};

type PanelBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

async function loadBars(symbols: string[]): Promise<Map<string, PanelBar[]>> {
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
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });

  const symbolById = new Map(instruments.map((i) => [i.id, i.symbol]));
  const bySymbol = new Map<string, PanelBar[]>();
  for (const row of rows) {
    const symbol = symbolById.get(row.instrumentId);
    if (!symbol) continue;
    const list = bySymbol.get(symbol) ?? [];
    list.push({
      date: row.date.toISOString().slice(0, 10),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: Number(row.volume ?? 0),
    });
    bySymbol.set(symbol, list);
  }
  return bySymbol;
}

const toDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function runStockPanelJob(): Promise<StockPanelJobResult> {
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

    // 低吸带的 Path 4 冻结取自 MPR。缺当日 Path 时按 0 处理（不冻结）。
    const phases = await prisma.macroPhaseState.findMany({ select: { date: true, pathId: true } });
    const pathByDate = new Map(
      phases.map((p) => [p.date.toISOString().slice(0, 10), p.pathId]),
    );

    const rows: {
      date: Date;
      symbol: string;
      close: number;
      rs: number;
      rsAccelerating: boolean;
      trendScore: number;
      stage: string;
      baseTier: string;
      baseDays: number;
      distFrom52wHigh: number;
      squeezeRatio: number;
      hurstReturn: number;
      hurstReturnRegime: string;
      hurstPrice: number;
      volatilityPattern: string;
      volumeRatio: number;
      moneyFlow: string;
      dipKind: string;
      dipQuality: string | null;
      dipLow: number | null;
      dipHigh: number | null;
      dipResistance: number | null;
    }[] = [];
    const skipped: string[] = [];
    let latestDate: string | null = null;

    for (const symbol of symbols) {
      const raw = bySymbol.get(symbol);
      if (!raw || raw.length < MIN_BARS) {
        skipped.push(symbol);
        continue;
      }

      // RS 要求个股与基准同一交易日轴，基准缺失的交易日直接丢弃
      const bars = raw.filter((b) => benchByDate.has(b.date));
      if (bars.length < MIN_BARS) {
        skipped.push(symbol);
        continue;
      }

      const closes = bars.map((b) => b.close);
      const bench = bars.map((b) => benchByDate.get(b.date)!);

      const rs = relativeRsSeries(closes, bench);
      const stages = computeStockStageSeries(bars, rs);
      const regimes = computeStockRegimeSeries(bars);

      const ema20 = emaSeries(closes, 20);
      const ema50 = emaSeries(closes, 50);
      const ema144 = emaSeries(closes, 144);
      const ema169 = emaSeries(closes, 169);
      const ema576 = emaSeries(closes, 576);
      const vwap90 = institutionalVwap(bars, 90);
      const vwap250 = institutionalVwap(bars, 250);
      // Pine 的 current_atr 是 sma(atr(14), 252)，不是 ATR14 本身
      const atr252 = smaOfNullable(atrSeries(bars, 14), 252);

      const last = bars.at(-1)!.date;
      if (latestDate == null || last > latestDate) latestDate = last;

      const from = Math.max(0, bars.length - UPSERT_DAYS);
      for (let i = from; i < bars.length; i += 1) {
        const stage = stages[i];
        const regime = regimes[i];
        const zone = computeDipZone({
          close: bars[i].close,
          atr: atr252[i] ?? 0,
          stage: stage.stage,
          trendScore: stage.trendScore,
          volumeRatio: regime.volumeRatio,
          pathId: pathByDate.get(bars[i].date) ?? 0,
          ema20: ema20[i],
          ema50: ema50[i],
          ema576: ema576[i],
          vwap90: vwap90[i],
          vwap250: vwap250[i],
          ema144: ema144[i],
          ema169: ema169[i],
        });

        rows.push({
          date: toDate(bars[i].date),
          symbol,
          close: bars[i].close,
          rs: rs[i],
          rsAccelerating: isRsAccelerating(closes, bench, i),
          trendScore: stage.trendScore,
          stage: stage.stage,
          baseTier: stage.baseTier,
          baseDays: stage.baseDays,
          distFrom52wHigh: stage.distFrom52wHigh,
          squeezeRatio: stage.squeezeRatio,
          hurstReturn: regime.hurstReturn,
          hurstReturnRegime: regime.hurstReturnRegime,
          hurstPrice: regime.hurstPrice,
          volatilityPattern: regime.volatilityPattern,
          volumeRatio: regime.volumeRatio,
          moneyFlow: regime.moneyFlow,
          dipKind: zone.kind,
          dipQuality: zone.kind === "range" ? zone.quality : null,
          dipLow: zone.kind === "range" ? zone.low : null,
          dipHigh: zone.kind === "range" ? zone.high : null,
          dipResistance: zone.kind === "avoid" ? zone.resistance : null,
        });
      }
    }

    if (rows.length === 0) {
      throw new Error("无可用标的，请先执行 npm run backfill:rotation");
    }

    // 先删后插：逐条 upsert 在 Neon 上会撞事务超时，这里只有两条语句。
    const windowStart = rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date);
    await prisma.$transaction([
      prisma.stockPanelState.deleteMany({ where: { date: { gte: windowStart } } }),
      prisma.stockPanelState.createMany({ data: rows }),
    ]);
    rowsWritten = rows.length;

    const finishedAt = new Date();
    await prisma.jobRun.create({
      data: {
        name: "stock-panel",
        status: "SUCCESS",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        recordsWritten: rowsWritten,
        details: { latestDate, symbolsEvaluated: symbols.length - skipped.length, symbolsSkipped: skipped },
      },
    });

    return {
      latestDate,
      symbolsEvaluated: symbols.length - skipped.length,
      symbolsSkipped: skipped,
      rowsWritten,
    };
  } catch (error) {
    const finishedAt = new Date();
    await prisma.jobRun.create({
      data: {
        name: "stock-panel",
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