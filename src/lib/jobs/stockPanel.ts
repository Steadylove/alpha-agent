import type { StockPanelData, StockPanelRow } from "@/lib/dashboard/stockPanel";
import { computeDipZone } from "@/lib/scoring/dipZone";
import { computeLogMacdSeries } from "@/lib/scoring/logMacd";
import { inShortTermDowntrend, mprAlphaRsSeries } from "@/lib/scoring/mprAlphaRs";
import { isRsAccelerating, relativeRsSeries } from "@/lib/scoring/relativeRs";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import {
  type SectorClockDay,
  computeSectorClockSeries,
  sectorStanding,
} from "@/lib/scoring/sectorClock";
import {
  type SectorClockId,
  SECTOR_UNIVERSE,
} from "@/lib/scoring/sectorUniverse";
import { atrSeries, emaSeries, smaOfNullable } from "@/lib/scoring/series";
import { computeStockRegimeSeries } from "@/lib/scoring/stockRegime";
import { COMMERCIAL_SPEC } from "@/lib/config/commercialSpec";
import { loadEarlyBreakevenDates } from "@/lib/jobs/earlyBreakeven";
import { DEFAULT_STOCK_RISK_PARAMS, computeStockRisk } from "@/lib/scoring/stockRisk";
import { computeStockStageSeries, dipStageOf, institutionalVwap } from "@/lib/scoring/stockStage";
import { computeTacticalGuide } from "@/lib/scoring/tacticalGuide";
import { loadDailyBars } from "@/lib/vps/loadDailyBars";
import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";
import type { MprData } from "@/lib/dashboard/mpr";
import type { StockValuationSnapshot } from "@/lib/jobs/stockValuation";
import type { ShortInterestSnapshot } from "@/lib/jobs/shortInterest";

/**
 * 每日重算个股深度面板：趋势打分、形态阶段、Hurst / VCP / 资金态、低吸支撑带、
 * SLS 行业站位、双仓位风控、战术指令。
 *
 * 与 rotationRadar 一样全历史重算——筑底天数、EMA576、Hurst 与风控仓位状态
 * 都要连续递推，且只回写一个窗口的每日状态，让底层日线的回补修正能自愈。
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
  sectorRowsWritten: number;
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
  return loadDailyBars(symbols);
}

const toDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function runStockPanelJob(): Promise<StockPanelJobResult> {
  const symbols = ROTATION_UNIVERSE.map((t) => t.symbol);
    const sectorSymbols = SECTOR_UNIVERSE.map((s) => s.symbol);
    const bySymbol = await loadBars([...symbols, ...sectorSymbols, BENCHMARK_SYMBOL]);

    const benchBars = bySymbol.get(BENCHMARK_SYMBOL);
    if (!benchBars || benchBars.length < MIN_BARS) {
      throw new Error(`基准 ${BENCHMARK_SYMBOL} 数据不足，先把日线 CSV 写到 VPS`);
    }
    const benchByDate = new Map(benchBars.map((b) => [b.date, b.close]));

    // 商业化开关默认关闭，此时不产生额外查询，口径与 Pine 一致。
    const earlyBreakevenDates = COMMERCIAL_SPEC.earlyBreakeven
      ? await loadEarlyBreakevenDates()
      : null;

    // 低吸带的 Path 4 冻结取自 MPR。缺当日 Path 时按 0 处理（不冻结）。
    const mpr = await readSnapshot<MprData>("mpr");
    const pathByDate = new Map((mpr?.history ?? []).map((p) => [p.date, p.pathId]));

    // SLS 时钟跑在基准的交易日轴上；ETF 未上市的日期填 null，Pine 会把它记 0 分
    const sectorCloses = {} as Record<SectorClockId, (number | null)[]>;
    for (const etf of SECTOR_UNIVERSE) {
      const closeByDate = new Map((bySymbol.get(etf.symbol) ?? []).map((b) => [b.date, b.close]));
      sectorCloses[etf.id] = benchBars.map((b) => closeByDate.get(b.date) ?? null);
    }
    const clockSeries = computeSectorClockSeries({
      sectorCloses,
      benchmarkCloses: benchBars.map((b) => b.close),
    });
    const clockByDate = new Map<string, SectorClockDay>(
      benchBars.map((b, i) => [b.date, clockSeries[i]]),
    );

    const clockIdBySymbol = new Map<string, SectorClockId>();

    const rows: {
      date: Date;
      symbol: string;
      close: number;
      rs: number;
      rsAccelerating: boolean;
      mprAlphaRs: number;
      inShortDowntrend: boolean;
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
      sectorId: string | null;
      sectorRank: number | null;
      sectorStatus: string | null;
      buy1Signal: boolean;
      buy2Signal: boolean;
      smoothedRsi: number | null;
      buy1Entry: number | null;
      buy1Stop: number | null;
      buy1Trail: number | null;
      buy1Locked: boolean;
      buy2Entry: number | null;
      buy2Stop: number | null;
      buy2Trail: number | null;
      buy2Locked: boolean;
      tacticalAction: string;
      tacticalTone: string;
      tacticalLayer: string;
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
      // MPR 口径的 4Q-Alpha 是另一套权重与映射，只用于原版实战指引的弱势分支
      const mprRs = mprAlphaRsSeries(closes, bench);
      const stages = computeStockStageSeries(bars, rs);
      const regimes = computeStockRegimeSeries(bars);

      const macd = computeLogMacdSeries(bars);
      const buy1 = macd.map((d) => d.buy1);
      const buy2 = macd.map((d) => d.buy2);
      const { days: risk } = computeStockRisk(bars, buy1, buy2, {
        ...DEFAULT_STOCK_RISK_PARAMS,
        useEarlyBreakeven: COMMERCIAL_SPEC.earlyBreakeven,
        earlyBreakevenActive: (i) => earlyBreakevenDates?.has(bars[i].date) ?? false,
      });

      const clockId = clockIdBySymbol.get(symbol) ?? null;

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
          stage: dipStageOf(stage.flags),
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

        const clockDay = clockByDate.get(bars[i].date);
        const standing = clockId && clockDay ? sectorStanding(clockDay, clockId) : null;

        const r = risk[i];
        const tactical = computeTacticalGuide({
          // 排除本根刚开的仓位，否则第 2 层「买点触发」永远够不着，见 tacticalGuide.ts
          holding: r.heldBeforeThisBar,
          buy1: buy1[i],
          buy2: buy2[i],
          rsiOk: r.rsiOk,
          pathId: pathByDate.get(bars[i].date) ?? 0,
          stage: stage.stage,
        });

        rows.push({
          date: toDate(bars[i].date),
          symbol,
          close: bars[i].close,
          rs: rs[i],
          rsAccelerating: isRsAccelerating(closes, bench, i),
          mprAlphaRs: mprRs[i],
          inShortDowntrend: inShortTermDowntrend(bars[i].close, ema20[i], ema50[i]),
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
          sectorId: clockId,
          sectorRank: standing?.rank ?? null,
          sectorStatus: standing?.status ?? null,
          buy1Signal: buy1[i],
          buy2Signal: buy2[i],
          smoothedRsi: r.smoothedRsi,
          buy1Entry: r.buy1Slot.entryPrice,
          buy1Stop: r.buy1Slot.stopLossLevel,
          buy1Trail: r.buy1Slot.trailLevel,
          buy1Locked: r.buy1Slot.breakevenLocked,
          buy2Entry: r.buy2Slot.entryPrice,
          buy2Stop: r.buy2Slot.stopLossLevel,
          buy2Trail: r.buy2Slot.trailLevel,
          buy2Locked: r.buy2Slot.breakevenLocked,
          tacticalAction: tactical.action,
          tacticalTone: tactical.tone,
          tacticalLayer: tactical.layer,
        });
      }
    }

    if (rows.length === 0) {
      throw new Error("无可用标的，先把日线 CSV 写到 VPS");
    }

    const sectorRows: {
      date: Date;
      sectorId: string;
      symbol: string;
      sls: number;
      mom21: number;
      rank: number;
      isTop3: boolean;
      isBottoming: boolean;
    }[] = [];
    for (let i = Math.max(0, benchBars.length - UPSERT_DAYS); i < benchBars.length; i += 1) {
      const day = clockSeries[i];
      for (const etf of SECTOR_UNIVERSE) {
        const standing = sectorStanding(day, etf.id);
        sectorRows.push({
          date: toDate(benchBars[i].date),
          sectorId: etf.id,
          symbol: etf.symbol,
          sls: standing.sls,
          mom21: standing.mom21,
          rank: standing.rank,
          isTop3: day.top3.includes(etf.id),
          isBottoming: day.bottoming.includes(etf.id),
        });
      }
    }

    const latestRows = rows.filter((r) => r.date.toISOString().slice(0, 10) === latestDate);
    const latestClock = sectorRows.filter((r) => r.date.toISOString().slice(0, 10) === latestDate);
    const valuations = await readSnapshot<StockValuationSnapshot>("valuation");
    const shorts = await readSnapshot<ShortInterestSnapshot>("short-interest");
    writeSnapshot(
      "stock-panel",
      assembleStockPanelSnapshot({
        latestDate,
        pathId: mpr?.latest?.pathId ?? null,
        rows: latestRows,
        sectorClock: latestClock,
        skipped,
        valuations,
        shorts,
      }),
    );

    return {
      latestDate,
      symbolsEvaluated: symbols.length - skipped.length,
      symbolsSkipped: skipped,
      rowsWritten: rows.length,
      sectorRowsWritten: sectorRows.length,
    };
}

function assembleStockPanelSnapshot(input: {
  latestDate: string | null;
  pathId: number | null;
  rows: Array<{
    symbol: string;
    close: number;
    rs: number;
    rsAccelerating: boolean;
    mprAlphaRs: number;
    inShortDowntrend: boolean;
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
    sectorId: string | null;
    sectorRank: number | null;
    sectorStatus: string | null;
    buy1Signal: boolean;
    buy2Signal: boolean;
    smoothedRsi: number | null;
    buy1Entry: number | null;
    buy1Stop: number | null;
    buy1Trail: number | null;
    buy1Locked: boolean;
    buy2Entry: number | null;
    buy2Stop: number | null;
    buy2Trail: number | null;
    buy2Locked: boolean;
    tacticalAction: string;
    tacticalTone: string;
    tacticalLayer: string;
  }>;
  sectorClock: Array<{
    sectorId: string;
    symbol: string;
    sls: number;
    mom21: number;
    rank: number;
    isTop3: boolean;
    isBottoming: boolean;
  }>;
  skipped: string[];
  valuations: StockValuationSnapshot | null;
  shorts: ShortInterestSnapshot | null;
}): StockPanelData {
  const nameBySymbol = new Map(ROTATION_UNIVERSE.map((t) => [t.symbol, t.name]));
  const sectorNameById = new Map(SECTOR_UNIVERSE.map((s) => [s.id as string, s.name]));
  const valuationBySymbol = new Map((input.valuations?.rows ?? []).map((v) => [v.symbol, v]));
  const shortBySymbol = new Map((input.shorts?.rows ?? []).map((r) => [r.symbol, r]));

  const panelRows: StockPanelRow[] = input.rows
    .map((s) => {
      const v = valuationBySymbol.get(s.symbol);
      const si = shortBySymbol.get(s.symbol);
      return {
        ...s,
        name: nameBySymbol.get(s.symbol) ?? s.symbol,
        sectorName: s.sectorId ? (sectorNameById.get(s.sectorId) ?? null) : null,
        valuation: v
          ? {
              primaryTarget: v.primaryTarget,
              upsidePct: v.upsidePct,
              mode: v.mode,
              archetype: v.archetype,
              consensusSmoothed: v.consensusSmoothed,
              currentPe: v.currentPe,
              calculatedPe: v.calculatedPe,
              marketCapB: v.marketCapB,
              isDipActive: v.isDipActive,
              shortTermTarget: v.shortTermTarget,
              squeezeTier: v.squeezeTier,
              shortInterestPct:
                si?.sharesOutstanding != null && si.sharesOutstanding > 0
                  ? (si.sharesShort / si.sharesOutstanding) * 100
                  : null,
              shortInterestDate: si?.settlementDate ?? null,
              isInLongDowntrend: v.isInLongDowntrend,
              isHyperMomentum: v.isHyperMomentum,
            }
          : null,
      };
    })
    .sort((a, b) => b.rs - a.rs);

  const STAGE_ORDER = ["A", "B", "W", "E", "D", "C"];
  return {
    latestDate: input.latestDate,
    valuationDate: input.valuations?.date ?? null,
    pathId: input.pathId,
    rows: panelRows,
    stageCounts: STAGE_ORDER.map((stage) => ({
      stage,
      count: panelRows.filter((r) => r.stage === stage).length,
    })).filter((s) => s.count > 0),
    sectorClock: input.sectorClock.map((c) => ({
      sectorId: c.sectorId,
      symbol: c.symbol,
      name: sectorNameById.get(c.sectorId) ?? c.sectorId,
      sls: c.sls,
      mom21: c.mom21,
      rank: c.rank,
      isTop3: c.isTop3,
      isBottoming: c.isBottoming,
    })),
    skippedSymbols: input.skipped,
    universeSize: ROTATION_UNIVERSE.length,
  };
}