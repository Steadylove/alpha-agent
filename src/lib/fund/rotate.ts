import {
  prepareSymbolInputs,
  tradeParamsOf,
  windowBounds,
  type BacktestConfig,
  type DayBook,
  type HoldingDay,
  type HoldingRow,
  type PreparedUniverse,
} from "@/lib/backtest/engine";
import {
  rotationTradeSteps,
  type ClosedTrade,
  type StepDecision,
  type StepView,
} from "@/lib/scoring/rotationTrade";

/** `none` = 满仓就放弃；`weakest`/`random` 只差挑谁当受害者。 */
export type RotateMode = "none" | "weakest" | "random";

export type RotateOpts = {
  slotPct: number;
  mode: RotateMode;
  edge: number;
  costBps: number;
  seed?: number;
  entryWindow?: "all" | "dayClose";
  entryGate?: (ticker: string, date: string) => boolean;
  slotPctOf?: (date: string) => number;
  slotScale?: (ticker: string, date: string) => number;
  dailyEntry?: Map<string, Set<string>>;
  exitWindow?: "all" | "dayClose";
  /** 搜参用：只留年化/回撤/开仓，不建账本和持仓明细。 */
  statsOnly?: boolean;
};

export type RotateResult = {
  cagr: number;
  dd: number;
  mar: number;
  entries: number;
  rotations: number;
  missed: number;
  avgHoldings: number;
  avgExposure: number;
  tradesPerYear: number;
  lotPnl: { symbol: string; pct: number }[];
  curve: { date: string; v: number }[];
  holdCounts: number[];
  book: DayBook[];
  holdings: HoldingDay[];
  trades: ClosedTrade[];
};

function statsOf(equity: number[], bpy: number) {
  const n = equity.length;
  let peak = equity[0] ?? 1;
  let maxDd = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, 1 - v / peak);
  }
  const years = n / bpy;
  const cagr = years > 0 ? ((equity[n - 1] ?? 1) ** (1 / years) - 1) * 100 : 0;
  const dd = maxDd * 100;
  return { cagr, dd, mar: dd > 0 ? cagr / dd : 0 };
}

type Slot = {
  shares: number;
  cost: number;
  eqAtEntry: number;
  entryDate: string;
  entryPrice: number;
  sigType: 1 | 2;
  entryRps: number;
};

/**
 * 现金账本回测。每笔固定投当时权益的 `slotPct`，现金不够就开不了仓。
 * 冻结档数字只从这里复现。
 */
export function runRotate(uni: PreparedUniverse, config: BacktestConfig, opts: RotateOpts): RotateResult {
  const { lo, hi } = windowBounds(uni.axis, config);
  const cost = opts.costBps / 10_000;
  const statsOnly = opts.statsOnly === true;
  const isDayClose = uni.axis.map(
    (a, i) => i + 1 >= uni.axis.length || uni.axis[i + 1].slice(0, 10) !== a.slice(0, 10),
  );

  const legs = uni.symbols.map((sym, idx) => {
    const inp = prepareSymbolInputs(uni.axis, sym, config, lo, hi);
    if (opts.dailyEntry) {
      const days = opts.dailyEntry.get(sym.ticker);
      for (let k = 0; k < inp.buy1.length; k += 1) {
        const gi = sym.axisIndex[k];
        inp.buy1[k] = isDayClose[gi] && !!days?.has(uni.axis[gi].slice(0, 10));
        inp.buy2[k] = false;
      }
    }
    return {
      idx,
      sym,
      gen: rotationTradeSteps(
        sym.ticker,
        inp.bars,
        inp.buy1,
        inp.buy2,
        inp.rs,
        {
          ...tradeParamsOf(config),
          ...(opts.exitWindow === "dayClose"
            ? { exitGate: (k: number) => isDayClose[sym.axisIndex[k]] }
            : {}),
        },
      ),
      cursor: 0,
      local: -1,
      view: null as StepView | null,
      lastClose: 0,
      lastRps: 0,
    };
  });

  const staleLegs = legs
    .map((leg) => ({ leg, end: leg.sym.axisIndex[leg.sym.axisIndex.length - 1] }))
    .filter(({ end }) => end < hi - 1);

  let cash = 1;
  const slots = new Map<number, Slot>();
  const lotPnl: { symbol: string; pct: number }[] = [];
  const trades: ClosedTrade[] = [];
  let orders: { idx: number; amount: number }[] = [];
  const decisions = new Map<number, StepDecision>();

  const equity: number[] = [];
  const curve: { date: string; v: number }[] = [];
  const holdCounts: number[] = [];
  const book: DayBook[] = [];
  const holdings: HoldingDay[] = [];
  let entries = 0;
  let rotations = 0;
  let missed = 0;
  let holdingSum = 0;
  let exposureSum = 0;
  let exits = 0;

  let lastEq = 1;
  let seed = opts.seed ?? 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let d = 0; d < hi; d += 1) {
    for (const leg of legs) {
      if (leg.cursor < leg.sym.axisIndex.length && leg.sym.axisIndex[leg.cursor] === d) {
        const r = leg.gen.next(decisions.get(leg.idx));
        leg.view = r.done ? null : r.value;
        leg.local = leg.cursor;
        leg.cursor += 1;
        leg.lastClose = leg.sym.close[leg.local];
        if (leg.sym.rps[leg.local] >= 1) leg.lastRps = leg.sym.rps[leg.local];
      } else {
        leg.view = null;
      }
    }
    decisions.clear();
    if (d < lo) continue;

    const sells: string[] = [];
    const closeSlot = (idx: number, price: number, trade: ClosedTrade | null) => {
      const slot = slots.get(idx);
      if (!slot) return;
      const proceeds = slot.shares * price * (1 - cost);
      cash += proceeds;
      exits += 1;
      if (!statsOnly && slot.eqAtEntry > 0) {
        lotPnl.push({
          symbol: legs[idx].sym.ticker,
          pct: ((proceeds - slot.cost) / slot.eqAtEntry) * 100,
        });
      }
      if (!statsOnly && trade) trades.push(trade);
      if (!statsOnly) sells.push(legs[idx].sym.ticker);
      slots.delete(idx);
    };

    for (const leg of legs) {
      const done = leg.view?.justClosed;
      if (!done) continue;
      closeSlot(leg.idx, done.exitPrice, done);
    }

    for (const { leg, end } of staleLegs) {
      if (d <= end) continue;
      if (!slots.has(leg.idx)) continue;
      closeSlot(leg.idx, leg.lastClose, null);
    }

    const buys: string[] = [];
    for (const leg of legs) {
      if (!leg.view?.day.entered) continue;
      const order = orders.find((o) => o.idx === leg.idx);
      const price = leg.view.day.entryPrice;
      if (!order || price == null || price <= 0) continue;
      const amount = Math.min(order.amount, cash);
      if (amount <= 1e-9) continue;
      const sig = leg.view.day.sigType === 2 ? 2 : 1;
      slots.set(leg.idx, {
        shares: (amount * (1 - cost)) / price,
        cost: amount,
        eqAtEntry: lastEq,
        entryDate: leg.view.day.entryDate ?? uni.axis[d],
        entryPrice: price,
        sigType: sig,
        entryRps: leg.view.day.entryRps ?? leg.lastRps,
      });
      cash -= amount;
      entries += 1;
      if (!statsOnly) buys.push(leg.sym.ticker);
    }
    orders = [];

    let held = 0;
    for (const [idx, slot] of slots) held += slot.shares * legs[idx].lastClose;
    const eq = cash + held;
    lastEq = eq;
    equity.push(eq);
    const date = uni.axis[d];
    curve.push({ date, v: eq });
    holdingSum += slots.size;
    if (!statsOnly) holdCounts.push(slots.size);
    const exposurePct = eq > 0 ? (held / eq) * 100 : 0;
    exposureSum += exposurePct;

    if (!statsOnly) {
      const rows: HoldingRow[] = [];
      for (const [idx, slot] of slots) {
        const close = legs[idx].lastClose;
        const value = slot.shares * close;
        rows.push({
          symbol: legs[idx].sym.ticker,
          weightPct: eq > 0 ? (value / eq) * 100 : 0,
          sigType: slot.sigType,
          entryDate: slot.entryDate,
          entryPrice: slot.entryPrice,
          floatPnlPct: slot.entryPrice > 0 ? ((close - slot.entryPrice) / slot.entryPrice) * 100 : 0,
          entryRps: slot.entryRps >= 1 ? slot.entryRps : null,
        });
      }
      rows.sort((a, b) => b.weightPct - a.weightPct);
      holdings.push({ date, rows });
      book.push({
        date,
        strategy: eq,
        benchmark: 1,
        spy: null,
        nHold: slots.size,
        exposurePct,
        buys,
        sells,
      });
    }

    const fresh = legs
      .filter((leg) => leg.view != null && leg.view.pendingEntry !== 0)
      .map((leg) => ({ leg, rps: leg.lastRps }))
      .sort((a, b) => b.rps - a.rps);
    if (fresh.length === 0) continue;

    if (opts.entryGate) {
      for (const cand of fresh) {
        if (!opts.entryGate(cand.leg.sym.ticker, date)) {
          decisions.set(cand.leg.idx, { rejectEntry: true });
          missed += 1;
        }
      }
    }

    if (opts.entryWindow === "dayClose" && !isDayClose[d]) {
      for (const cand of fresh) {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        missed += 1;
      }
      continue;
    }

    const slotAmount = eq * (opts.slotPctOf ? opts.slotPctOf(date) : opts.slotPct);
    let free = cash;
    const doomed = new Set<number>();

    for (const cand of fresh) {
      if (decisions.get(cand.leg.idx)?.rejectEntry) continue;
      const want = slotAmount * (opts.slotScale?.(cand.leg.sym.ticker, date) ?? 1);
      if (want <= 1e-9) {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        missed += 1;
        continue;
      }
      if (free >= want) {
        orders.push({ idx: cand.leg.idx, amount: want });
        free -= want;
        continue;
      }

      const alive = [...slots.keys()].filter((i) => !doomed.has(i));
      if (opts.mode === "none" || alive.length === 0) {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        missed += 1;
        continue;
      }

      const victim =
        opts.mode === "random"
          ? alive[Math.floor(rnd() * alive.length)]
          : alive.reduce((a, b) => (legs[a].lastRps <= legs[b].lastRps ? a : b));

      if (cand.rps > legs[victim].lastRps + opts.edge) {
        decisions.set(victim, { forceExit: true });
        doomed.add(victim);
        orders.push({ idx: cand.leg.idx, amount: slotAmount });
        const victimValue = slots.get(victim)!.shares * legs[victim].lastClose;
        free += victimValue * (1 - cost) - slotAmount;
        rotations += 1;
      } else {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        missed += 1;
      }
    }
  }

  const n = Math.max(1, equity.length);
  const byDay = new Map<string, number>();
  for (const pt of curve) byDay.set(pt.date.slice(0, 10), pt.v);
  const dailyEq = [...byDay.keys()].sort().map((k) => byDay.get(k)!);
  const s = statsOf(dailyEq, 252);
  const years = dailyEq.length / 252;
  return {
    ...s,
    entries,
    rotations,
    missed,
    avgHoldings: holdingSum / n,
    avgExposure: exposureSum / n,
    tradesPerYear: years > 0 ? (entries + exits) / years : 0,
    lotPnl,
    curve,
    holdCounts,
    book,
    holdings,
    trades,
  };
}
