import { COMMERCIAL_SPEC } from "@/lib/config/commercialSpec";
import { getPrisma } from "@/lib/db/prisma";
import { loadEarlyBreakevenDates } from "@/lib/jobs/earlyBreakeven";
import { computeLogMacdSeries } from "@/lib/scoring/logMacd";
import { percentileRsBySymbol } from "@/lib/scoring/percentileRs";
import { rotationRsSeries } from "@/lib/scoring/rotationRs";
import {
  DEFAULT_TRADE_PARAMS,
  computeRotationTrades,
  type ClosedTrade,
  type TradeBar,
} from "@/lib/scoring/rotationTrade";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";

/**
 * 每日重算 40 只标的的轮动信号与持仓状态，落库到 RotationState / RotationTrade。
 *
 * 全历史重算而非增量：对数 MACD 的死叉周期回溯与持仓状态机都是跨日递推的，
 * 必须从序列起点连续算才能得到正确的当前持仓。
 *
 * 与 macroPhase 一样只回写一个窗口的每日状态，让底层日线的回补修正能自愈；
 * 已平仓台账则全量重写，因为它本来就只有几百行。
 */

/** 每日状态回写天数，需覆盖前端看板的展示长度并为节假日留余量。 */
const UPSERT_DAYS = 180;
/** 样本太短时对数 MACD 与 RS 都没有意义，跳过该标的。 */
const MIN_BARS = 400;

export type RotationRadarJobResult = {
  latestDate: string | null;
  symbolsEvaluated: number;
  symbolsSkipped: string[];
  activePositions: number;
  /** 当日新点火的标的，Phase 6 的推送门控要用。 */
  firedToday: { symbol: string; sigType: number }[];
  /** 当日触发止损离场的标的。 */
  exitedToday: { symbol: string; pnlPct: number }[];
  stateRowsWritten: number;
  tradeRowsWritten: number;
};

type Loaded = { symbol: string; bars: TradeBar[] };

async function loadBars(): Promise<{ loaded: Loaded[]; skipped: string[] }> {
  const prisma = getPrisma();
  const symbols = ROTATION_UNIVERSE.map((t) => t.symbol);
  const instruments = await prisma.instrument.findMany({
    where: { symbol: { in: symbols } },
    select: { id: true, symbol: true },
  });

  const bars = await prisma.dailyBar.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, date: true, high: true, low: true, close: true },
  });

  const bySymbol = new Map<string, TradeBar[]>();
  const symbolById = new Map(instruments.map((i) => [i.id, i.symbol]));
  for (const bar of bars) {
    const symbol = symbolById.get(bar.instrumentId);
    if (!symbol) continue;
    const list = bySymbol.get(symbol) ?? [];
    list.push({
      date: bar.date.toISOString().slice(0, 10),
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });
    bySymbol.set(symbol, list);
  }

  const loaded: Loaded[] = [];
  const skipped: string[] = [];
  for (const symbol of symbols) {
    const list = bySymbol.get(symbol);
    if (!list || list.length < MIN_BARS) {
      skipped.push(symbol);
      continue;
    }
    loaded.push({ symbol, bars: list });
  }

  return { loaded, skipped };
}

const toDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** 截面 RS 的基准，只在 `COMMERCIAL_SPEC.percentileRs` 打开时才需要加载。 */
const BENCHMARK_SYMBOL = "SPY";

async function loadBenchmark(): Promise<{ dates: string[]; closes: number[] }> {
  const prisma = getPrisma();
  const instrument = await prisma.instrument.findUnique({
    where: { symbol: BENCHMARK_SYMBOL },
    select: { id: true },
  });
  if (!instrument) {
    throw new Error(`截面 RS 需要基准 ${BENCHMARK_SYMBOL}，请先执行 npm run backfill:rotation`);
  }
  const bars = await prisma.dailyBar.findMany({
    where: { instrumentId: instrument.id },
    orderBy: { date: "asc" },
    select: { date: true, close: true },
  });
  return {
    dates: bars.map((b) => b.date.toISOString().slice(0, 10)),
    closes: bars.map((b) => b.close),
  };
}


export async function runRotationRadarJob(): Promise<RotationRadarJobResult> {
  const prisma = getPrisma();
  const startedAt = new Date();
  let stateRowsWritten = 0;
  let tradeRowsWritten = 0;

  try {
    const { loaded, skipped } = await loadBars();
    if (loaded.length === 0) {
      throw new Error("无可用标的，请先执行 npm run backfill:rotation");
    }

    // 各标的的最新交易日可能不同（停牌、上市时间），以全池最大值为准
    const latestDate = loaded
      .map((l) => l.bars.at(-1)!.date)
      .reduce((a, b) => (b > a ? b : a));

    const stateRows: {
      date: Date;
      symbol: string;
      close: number;
      rs: number;
      sigType: number;
      buy1: boolean;
      buy2: boolean;
      entryPrice: number | null;
      stopLevel: number | null;
      trailLevel: number | null;
      effectiveStop: number | null;
      floatPnlPct: number;
      maxPnlPct: number;
      breakevenLocked: boolean;
    }[] = [];
    const allTrades: ClosedTrade[] = [];
    const firedToday: { symbol: string; sigType: number }[] = [];
    const exitedToday: { symbol: string; pnlPct: number }[] = [];
    let activePositions = 0;

    // 商业化开关全部默认关闭，此时下面两处都不产生额外查询，口径与 Pine 一致。
    const percentileRs = COMMERCIAL_SPEC.percentileRs
      ? percentileRsBySymbol(
          loaded.map((l) => ({
            symbol: l.symbol,
            dates: l.bars.map((b) => b.date),
            closes: l.bars.map((b) => b.close),
          })),
          await loadBenchmark(),
        )
      : null;
    const earlyBreakevenDates = COMMERCIAL_SPEC.earlyBreakeven
      ? await loadEarlyBreakevenDates()
      : null;

    for (const { symbol, bars } of loaded) {
      const macd = computeLogMacdSeries(bars);
      const rs = percentileRs?.get(symbol) ?? rotationRsSeries(bars.map((b) => b.close));
      const buy1 = macd.map((d) => d.buy1);
      const buy2 = macd.map((d) => d.buy2);
      const { days, closed } = computeRotationTrades(symbol, bars, buy1, buy2, rs, {
        ...DEFAULT_TRADE_PARAMS,
        useCommercialRsGate: COMMERCIAL_SPEC.rsEntryVeto,
        useEarlyBreakeven: COMMERCIAL_SPEC.earlyBreakeven,
        earlyBreakevenActive: (i) => earlyBreakevenDates?.has(bars[i].date) ?? false,
      });

      allTrades.push(...closed);

      const from = Math.max(0, bars.length - UPSERT_DAYS);
      for (let i = from; i < bars.length; i += 1) {
        const day = days[i];
        stateRows.push({
          date: toDate(bars[i].date),
          symbol,
          close: bars[i].close,
          rs: rs[i],
          sigType: day.sigType,
          buy1: buy1[i],
          buy2: buy2[i],
          entryPrice: day.entryPrice,
          stopLevel: day.stopLevel,
          trailLevel: day.trailLevel,
          effectiveStop: day.effectiveStop,
          floatPnlPct: day.floatPnlPct,
          maxPnlPct: day.maxPnlPct,
          breakevenLocked: day.breakevenLocked,
        });
      }

      const last = days.at(-1)!;
      if (last.sigType !== 0) activePositions += 1;
      if (bars.at(-1)!.date === latestDate) {
        if (last.entered) firedToday.push({ symbol, sigType: last.sigType });
        if (last.exited) {
          exitedToday.push({ symbol, pnlPct: closed.at(-1)?.pnlPct ?? 0 });
        }
      }
    }

    // 先删后插：逐条 upsert 在 Neon 上会撞事务超时，这里只有两条语句。
    const windowStart = stateRows.reduce(
      (min, r) => (r.date < min ? r.date : min),
      stateRows[0].date,
    );
    await prisma.$transaction([
      prisma.rotationState.deleteMany({ where: { date: { gte: windowStart } } }),
      prisma.rotationState.createMany({ data: stateRows }),
    ]);
    stateRowsWritten = stateRows.length;

    const tradeRows = allTrades.map((t) => ({
      symbol: t.symbol,
      sigType: t.sigType,
      entryDate: toDate(t.entryDate),
      entryPrice: t.entryPrice,
      exitDate: toDate(t.exitDate),
      exitPrice: t.exitPrice,
      pnlPct: t.pnlPct,
      barsHeld: t.barsHeld,
    }));
    await prisma.$transaction([
      prisma.rotationTrade.deleteMany({}),
      prisma.rotationTrade.createMany({ data: tradeRows }),
    ]);
    tradeRowsWritten = tradeRows.length;

    const finishedAt = new Date();
    await prisma.jobRun.create({
      data: {
        name: "rotation-radar",
        status: "SUCCESS",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        recordsRead: loaded.reduce((sum, l) => sum + l.bars.length, 0),
        recordsWritten: stateRowsWritten + tradeRowsWritten,
        details: {
          latestDate,
          symbolsEvaluated: loaded.length,
          symbolsSkipped: skipped,
          activePositions,
          firedToday,
          exitedToday,
        },
      },
    });

    return {
      latestDate,
      symbolsEvaluated: loaded.length,
      symbolsSkipped: skipped,
      activePositions,
      firedToday,
      exitedToday,
      stateRowsWritten,
      tradeRowsWritten,
    };
  } catch (error) {
    const finishedAt = new Date();
    await prisma.jobRun.create({
      data: {
        name: "rotation-radar",
        status: "FAILED",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        recordsWritten: stateRowsWritten + tradeRowsWritten,
        error: error instanceof Error ? error.message : String(error),
        details: {},
      },
    });
    throw error;
  }
}
