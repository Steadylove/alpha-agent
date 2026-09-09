import { COMMERCIAL_SPEC } from "@/lib/config/commercialSpec";
import type { RotationData, RotationHolding } from "@/lib/dashboard/rotation";
import { loadEarlyBreakevenDates } from "@/lib/jobs/earlyBreakeven";
import { PATH_EXPOSURE, macroExposurePct } from "@/lib/scoring/macroExposure";
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
import { loadDailyBars } from "@/lib/vps/loadDailyBars";
import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";
import type { MprData } from "@/lib/dashboard/mpr";

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

/** 带开盘价的 K 线：交易模拟只要 TradeBar，顶背离额外要实体上沿。 */
type SignalBar = TradeBar & { open: number };

type Loaded = { symbol: string; bars: SignalBar[] };

async function loadBars(): Promise<{ loaded: Loaded[]; skipped: string[] }> {
  const symbols = ROTATION_UNIVERSE.map((t) => t.symbol);
  const bySymbol = await loadDailyBars(symbols);
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

export async function runRotationRadarJob(): Promise<RotationRadarJobResult> {
  const { loaded, skipped } = await loadBars();
    if (loaded.length === 0) {
      throw new Error("无可用标的，先把轮动池日线 CSV 写到 VPS");
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

    const mpr = await readSnapshot<MprData>("mpr");
    const pathId = mpr?.latest?.pathId ?? null;
    writeSnapshot(
      "rotation",
      assembleRotationSnapshot({
        latestDate,
        stateRows,
        trades: allTrades,
        skipped,
        pathId,
      }),
    );

    return {
      latestDate,
      symbolsEvaluated: loaded.length,
      symbolsSkipped: skipped,
      activePositions,
      firedToday,
      exitedToday,
      stateRowsWritten: stateRows.length,
      tradeRowsWritten: allTrades.length,
    };
}

const AVG_SLOTS = 8;
const RECENT_SIGNAL_DAYS = 30;

function assembleRotationSnapshot(input: {
  latestDate: string;
  stateRows: {
    date: Date;
    symbol: string;
    close: number;
    rs: number;
    sigType: number;
    buy1: boolean;
    buy2: boolean;
    entryPrice: number | null;
    effectiveStop: number | null;
    floatPnlPct: number;
    maxPnlPct: number;
    breakevenLocked: boolean;
  }[];
  trades: ClosedTrade[];
  skipped: string[];
  pathId: number | null;
}): RotationData {
  const latestDate = new Date(`${input.latestDate}T00:00:00.000Z`);
  const yearStart = new Date(Date.UTC(latestDate.getUTCFullYear(), 0, 1));
  const since = new Date(latestDate);
  since.setUTCDate(since.getUTCDate() - RECENT_SIGNAL_DAYS);

  const rows = input.stateRows.filter((r) => r.date.getTime() === latestDate.getTime());
  const closedThisYear = input.trades.filter((t) => toDate(t.exitDate) >= yearStart);
  const signalRows = input.stateRows
    .filter((r) => r.date >= since && (r.buy1 || r.buy2))
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const active = rows.filter((r) => r.sigType > 0);
  const activeRsSum = active.reduce((sum, r) => sum + r.rs, 0);
  const exposureScale =
    COMMERCIAL_SPEC.macroExposureScaling && input.pathId != null
      ? macroExposurePct(input.pathId) / 100
      : 1;

  const toHolding = (row: (typeof rows)[number]): RotationHolding => {
    const weightPct =
      row.sigType > 0 && activeRsSum > 0 ? (row.rs / activeRsSum) * 100 * exposureScale : 0;
    return {
      symbol: row.symbol,
      close: row.close,
      rs: row.rs,
      sigType: row.sigType,
      entryPrice: row.entryPrice,
      effectiveStop: row.effectiveStop,
      floatPnlPct: row.floatPnlPct,
      maxPnlPct: row.maxPnlPct,
      breakevenLocked: row.breakevenLocked,
      weightPct,
      navContribPct: row.floatPnlPct * (weightPct / 100),
    };
  };

  const all = rows.map(toHolding).sort((a, b) => b.rs - a.rs);
  const holdings = all.filter((h) => h.sigType > 0).sort((a, b) => b.weightPct - a.weightPct);
  const closedPnlSum = closedThisYear.reduce((sum, t) => sum + t.pnlPct, 0);
  const wins = closedThisYear.filter((t) => t.pnlPct > 0).length;
  const openNavPct = holdings.reduce((sum, h) => sum + h.navContribPct, 0);
  const closedNavPct = closedPnlSum / AVG_SLOTS;
  const ytdStates = input.stateRows
    .filter((r) => r.date >= yearStart)
    .map((r) => ({ date: r.date, rs: r.rs, sigType: r.sigType, floatPnlPct: r.floatPnlPct }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const { navCurve, maxDrawdownPct } = buildNavCurve(
    ytdStates,
    closedThisYear.map((t) => ({ exitDate: toDate(t.exitDate), pnlPct: t.pnlPct })),
  );

  return {
    latestDate: input.latestDate,
    holdings,
    all,
    recentSignals: signalRows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      symbol: r.symbol,
      sigType: r.buy1 ? 1 : 2,
      rs: r.rs,
      close: r.close,
    })),
    navCurve,
    maxDrawdownPct,
    stats: {
      closedPnlSum,
      closedNavPct,
      openNavPct,
      totalNavPct: closedNavPct + openNavPct,
      trades: closedThisYear.length,
      wins,
      winRatePct: closedThisYear.length > 0 ? (wins / closedThisYear.length) * 100 : 0,
    },
    universeSize: ROTATION_UNIVERSE.length,
    skippedSymbols: input.skipped,
    macroExposure:
      input.pathId == null
        ? null
        : { pathId: input.pathId, ...(PATH_EXPOSURE[input.pathId] ?? PATH_EXPOSURE[4]) },
  };
}

function buildNavCurve(
  states: { date: Date; rs: number; sigType: number; floatPnlPct: number }[],
  closedTrades: { exitDate: Date; pnlPct: number }[],
): { navCurve: RotationData["navCurve"]; maxDrawdownPct: number } {
  if (states.length === 0) return { navCurve: [], maxDrawdownPct: 0 };

  const byDate = new Map<number, typeof states>();
  for (const s of states) {
    const key = s.date.getTime();
    const bucket = byDate.get(key);
    if (bucket) bucket.push(s);
    else byDate.set(key, [s]);
  }

  const exits = [...closedTrades].sort((a, b) => a.exitDate.getTime() - b.exitDate.getTime());
  let exitIdx = 0;
  let closedCum = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  const navCurve: RotationData["navCurve"] = [];

  for (const key of [...byDate.keys()].sort((a, b) => a - b)) {
    while (exitIdx < exits.length && exits[exitIdx].exitDate.getTime() < key) {
      closedCum += exits[exitIdx].pnlPct;
      exitIdx += 1;
    }
    const day = byDate.get(key)!;
    const active = day.filter((s) => s.sigType > 0);
    const openSum = active.reduce((sum, s) => sum + s.floatPnlPct, 0);
    const navPct = (closedCum + openSum) / AVG_SLOTS;
    peak = Math.max(peak, navPct);
    const drawdownPct = navPct - peak;
    maxDrawdownPct = Math.min(maxDrawdownPct, drawdownPct);
    navCurve.push({
      date: new Date(key).toISOString().slice(0, 10),
      navPct,
      drawdownPct,
      holdings: active.length,
    });
  }
  return { navCurve, maxDrawdownPct };
}
