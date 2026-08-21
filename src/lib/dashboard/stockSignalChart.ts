import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { computeLogMacdSeries } from "@/lib/scoring/logMacd";
import { computeStockRisk, type ClosedRiskTrade } from "@/lib/scoring/stockRisk";

export type Candle = {
  /** YYYY-MM-DD，lightweight-charts 的 business day 字符串。 */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** 某个仓位槽在某一根上的两条防线，空仓为 null。 */
export type StopPoint = { time: string; stop: number | null; trail: number | null };

export type SignalMarker = {
  time: string;
  kind: "buy1" | "buy2" | "exit";
  /** 建仓价或离场价。 */
  price: number;
  /** 仅离场标记有：来自哪个槽、盈亏、离场原因。 */
  slot?: "buy1" | "buy2";
  pnlPct?: number;
  reason?: "stop_loss" | "trail";
  /** 仅建仓标记有：信号成型但 RSI 闸门拦下时为 true。 */
  blocked?: boolean;
};

export type TradeRow = {
  slot: "buy1" | "buy2";
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  pnlPct: number;
  barsHeld: number;
  reason: "stop_loss" | "trail";
};

export type StockSignalChartData = {
  symbol: string;
  name: string;
  candles: Candle[];
  markers: SignalMarker[];
  buy1Stops: StopPoint[];
  buy2Stops: StopPoint[];
  trades: TradeRow[];
  /** 当前仍持有的槽。 */
  openSlots: { slot: "buy1" | "buy2"; entryPrice: number; stop: number; trail: number; pnlPct: number }[];
  /** 全历史用于预热，只展示窗口内的部分。 */
  windowDays: number;
  totalBars: number;
};

/** 图表窗口。信号本身在全历史上推进，这里只决定画多少。 */
const WINDOW_DAYS = 900;

/**
 * 取单只标的的 K 线，并把一买/二买信号与双槽风控还原成图表序列。
 *
 * 信号与风控必须在**全历史**上推进：EMA89/90 要预热，`ta.barssince` 链更是
 * 从上市第一根累积下来的，截断窗口再算会得到完全不同的信号点。
 * 因此这里先全量计算，最后才切出展示窗口。
 */
export async function getStockSignalChart(symbol: string): Promise<StockSignalChartData | null> {
  if (!process.env.DATABASE_URL) return null;

  const upper = symbol.toUpperCase();
  const target = ROTATION_UNIVERSE.find((t) => t.symbol === upper);
  if (!target) return null;

  const { getPrisma } = await import("@/lib/db/prisma");
  const prisma = getPrisma();

  const instrument = await prisma.instrument.findUnique({ where: { symbol: upper } });
  if (!instrument) return null;

  const rows = await prisma.dailyBar.findMany({
    where: { instrumentId: instrument.id },
    orderBy: { date: "asc" },
    select: { date: true, open: true, high: true, low: true, close: true, volume: true },
  });
  if (rows.length < 200) return null;

  const bars = rows.map((r) => ({ high: r.high, low: r.low, close: r.close }));
  const signals = computeLogMacdSeries(bars);
  const { days, closed } = computeStockRisk(
    bars,
    signals.map((d) => d.buy1),
    signals.map((d) => d.buy2),
  );

  const iso = (i: number) => rows[i].date.toISOString().slice(0, 10);
  const start = Math.max(0, rows.length - WINDOW_DAYS);
  const inWindow = (i: number) => i >= start;

  const candles: Candle[] = [];
  const buy1Stops: StopPoint[] = [];
  const buy2Stops: StopPoint[] = [];
  for (let i = start; i < rows.length; i += 1) {
    const r = rows[i];
    const time = iso(i);
    candles.push({
      time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: Number(r.volume ?? 0),
    });
    buy1Stops.push({
      time,
      stop: days[i].buy1Slot.stopLossLevel,
      trail: days[i].buy1Slot.trailLevel,
    });
    buy2Stops.push({
      time,
      stop: days[i].buy2Slot.stopLossLevel,
      trail: days[i].buy2Slot.trailLevel,
    });
  }

  const markers: SignalMarker[] = [];
  for (let i = start; i < rows.length; i += 1) {
    // Pine 的信号成型与实际建仓是两回事：RSI 闸门会拦下一部分点火。
    if (signals[i].buy1) {
      markers.push({
        time: iso(i),
        kind: "buy1",
        price: rows[i].close,
        blocked: !days[i].rsiOk,
      });
    }
    if (signals[i].buy2) {
      markers.push({
        time: iso(i),
        kind: "buy2",
        price: rows[i].close,
        blocked: !days[i].rsiOk,
      });
    }
  }

  const toRow = (t: ClosedRiskTrade): TradeRow => ({
    slot: t.slot,
    entryDate: iso(t.entryIndex),
    entryPrice: t.entryPrice,
    exitDate: iso(t.exitIndex),
    exitPrice: t.exitPrice,
    pnlPct: t.pnlPct,
    barsHeld: t.barsHeld,
    reason: t.reason,
  });

  for (const t of closed) {
    if (!inWindow(t.exitIndex)) continue;
    markers.push({
      time: iso(t.exitIndex),
      kind: "exit",
      price: t.exitPrice,
      slot: t.slot,
      pnlPct: t.pnlPct,
      reason: t.reason,
    });
  }
  markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const lastDay = days[days.length - 1];
  const lastClose = rows[rows.length - 1].close;
  const openSlots: StockSignalChartData["openSlots"] = [];
  for (const key of ["buy1", "buy2"] as const) {
    const slot = key === "buy1" ? lastDay.buy1Slot : lastDay.buy2Slot;
    if (slot.entryPrice == null) continue;
    openSlots.push({
      slot: key,
      entryPrice: slot.entryPrice,
      stop: slot.stopLossLevel ?? 0,
      trail: slot.trailLevel ?? 0,
      pnlPct: ((lastClose - slot.entryPrice) / slot.entryPrice) * 100,
    });
  }

  return {
    symbol: upper,
    name: target.name,
    candles,
    markers,
    buy1Stops,
    buy2Stops,
    trades: closed.filter((t) => inWindow(t.exitIndex)).map(toRow).reverse(),
    openSlots,
    windowDays: candles.length,
    totalBars: rows.length,
  };
}
