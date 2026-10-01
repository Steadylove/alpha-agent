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
  type RotationTradeState,
} from "@/lib/scoring/rotationTrade";

import { localSignalId, localSignalTime, signalParameters, type SignalTracking, type SignalExecutionEvent, type SignalExecutionReason, type TrackedSignalState } from "./signalTracking";

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
  /** 当前账本才开启；回测保留原来的整段计算方式。 */
  continuation?: { checkpoint?: RotateCheckpoint; capture?: boolean };
  /** 连续账本缺少后续报价时保留持仓，不能凭最后一根报价虚构卖出。 */
  retainMissing?: boolean;
  /** 挂单在成交前也核对池子；被移出后取消尚未成交的买单。 */
  fillGate?: (ticker: string, date: string) => boolean;
  /** Live books keep the independent strategy cycle alive when the account skips a buy. */
  separateSignalState?: boolean;
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
  missedBuys: { date: string; symbol: string; price: number }[];
  checkpoint?: RotateCheckpoint;
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

export type Slot = {
  shares: number;
  cost: number;
  eqAtEntry: number;
  entryDate: string;
  entryPrice: number;
  sigType: 1 | 2;
  entryRps: number;
};

export type RotateCheckpoint = {
  version: 1;
  asOf: string;
  cash: number;
  lastEq: number;
  seed: number;
  slots: Record<string, Slot>;
  legs: Record<string, { state: RotationTradeState; lastClose: number; lastRps: number }>;
  orders: { symbol: string; amount: number }[];
  decisions: Record<string, StepDecision>;
  dailyEquity: { date: string; v: number }[];
  signalTracking?: SignalTracking;
  totals: { entries: number; rotations: number; missed: number; holdingSum: number; exposureSum: number; exits: number; wins: number; bars: number };
};

/**
 * 现金账本回测。每笔固定投当时权益的 `slotPct`，现金不够就开不了仓。
 * 冻结档数字只从这里复现。
 */
export function runRotate(uni: PreparedUniverse, config: BacktestConfig, opts: RotateOpts): RotateResult {
  const { lo, hi } = windowBounds(uni.axis, config);
  const cost = opts.costBps / 10_000;
  const statsOnly = opts.statsOnly === true;
  const resume = opts.continuation?.checkpoint;
  const capture = opts.continuation?.capture === true;
  const separate = opts.separateSignalState === true;
  const tracking: SignalTracking | undefined = separate ? resume?.signalTracking
    ? structuredClone(resume.signalTracking)
    : { version: 1, activatedAt: resume?.asOf ?? uni.axis[lo] ?? "", asOf: resume?.asOf ?? "",
        parameters: signalParameters(config, opts.entryWindow === "dayClose"), states: {}, events: [],
        accounts: Object.fromEntries([...new Set([...Object.keys(resume?.slots ?? {}), ...(resume?.orders ?? []).map(o => o.symbol)])]
          .map(symbol => [symbol, { signalId: null, legacy: true }])),
        migration: { at: resume?.asOf ?? uni.axis[lo] ?? "",
          positions: Object.entries(resume?.slots ?? {}).map(([symbol, slot]) => ({ symbol, entryDate: slot.entryDate, entryPrice: slot.entryPrice, reason: "legacy" as const })),
          pending: (resume?.orders ?? []).map(o => o.symbol) } }
    : undefined;
  if (tracking && JSON.stringify(tracking.parameters) !== JSON.stringify(signalParameters(config, opts.entryWindow === "dayClose"))) {
    throw new Error("独立信号策略参数已变化，停止续算并保留原账本；请先建立明确的参数迁移版本");
  }
  const eventIndex = new Map(tracking?.events.map(event => [event.id, event]) ?? []);
  const record = (event: SignalExecutionEvent) => {
    if (!tracking || eventIndex.has(event.id)) return;
    tracking.events.push(event); eventIndex.set(event.id, event);
  };
  const entryEvent = (signalId: string | null | undefined) => signalId ? eventIndex.get(`${signalId}:buy`) : undefined;
  const decide = (signalId: string | null | undefined, reason: SignalExecutionReason) => {
    const event = entryEvent(signalId);
    if (event && event.status === "pending") { event.status = "skipped"; event.reason = reason; }
  };
  const isDayClose = uni.axis.map(
    (a, i) => i + 1 >= uni.axis.length || uni.axis[i + 1].slice(0, 10) !== a.slice(0, 10),
  );
  const delayedOrders = new Set<string>();

  const legs = uni.symbols.map((sym, idx) => {
    const previous = resume?.legs[sym.ticker];
    let accountState = previous?.state;
    const inp = prepareSymbolInputs(uni.axis, sym, config, lo, hi);
    if (opts.dailyEntry) {
      const days = opts.dailyEntry.get(sym.ticker);
      for (let k = 0; k < inp.buy1.length; k += 1) {
        const gi = sym.axisIndex[k];
        inp.buy1[k] = isDayClose[gi] && !!days?.has(uni.axis[gi].slice(0, 10));
        inp.buy2[k] = false;
      }
    }
    // Strategy-only state sees technical signals even if the account has no cash, RPS eligibility, or pool membership.
    // Replaying a newly added symbol up to the checkpoint avoids fabricating a fresh cycle from flat.
    let shadow: Generator<StepView, void, StepDecision | undefined> | undefined;
    let signal: TrackedSignalState | undefined = tracking?.states[sym.ticker];
    if (tracking) {
      const shadowInputs = prepareSymbolInputs(uni.axis, { ...sym,
        rps: new Float32Array(sym.close.length).fill(100), isMember: new Uint8Array(sym.close.length).fill(1) },
        { ...config, rpsMin: 0, minPrice: 0, minAdtvUsd: 0, requireTrend: false }, 0, hi);
      if (signal && !signal.lastProcessedDate) {
        throw new Error(`${sym.ticker} 独立信号状态缺少逐票 K 线水位，不能猜测恢复位置；原账本已保留`);
      }
      const lastProcessedDate = signal?.lastProcessedDate;
      const shadowFrom = signal ? shadowInputs.bars.findIndex((bar) => bar.date === lastProcessedDate) + 1 : 0;
      if (signal && (!resume || signal.lastProcessedDate! > resume.asOf || shadowFrom === 0)) {
        throw new Error(`${sym.ticker} 独立信号水位与现有行情不一致，原账本已保留`);
      }
      shadow = rotationTradeSteps(sym.ticker, shadowInputs.bars, shadowInputs.buy1, shadowInputs.buy2, shadowInputs.rs,
        { ...tradeParamsOf(config), rsExitBelow: null },
        { ...(signal ? { after: signal.lastProcessedDate, state: signal.state } : {}), capture: true });
      if (resume) {
        // Late tail bars may be older than the portfolio cutoff but newer than this symbol's state.
        // Advance technical state only: never replay account fills or rewrite prior audit events.
        for (let k = shadowFrom; k < sym.axisIndex.length && uni.axis[sym.axisIndex[k]] <= resume.asOf; k += 1) {
          const pendingSignalId = signal?.state.pendingEntry ? signal.signalId : null;
          const step = shadow.next();
          if (step.done) break;
          const account = tracking.accounts[sym.ticker];
          if (step.value.day.entered && pendingSignalId && account?.signalId === pendingSignalId &&
            !account.legacy && accountState?.pendingEntry && !resume.slots[sym.ticker] &&
            resume.orders.some((order) => order.symbol === sym.ticker)) {
            // The intended next-bar execution was discovered inside already booked history.
            // Cancel only the unfilled order; executing it at a later quote would be a catch-up buy.
            delayedOrders.add(sym.ticker);
            accountState = { ...accountState, pendingEntry: 0 };
            decide(pendingSignalId, "delayed_quote");
            delete tracking.accounts[sym.ticker];
          }
          const date = uni.axis[sym.axisIndex[k]];
          if (step.value.justClosed) signal = { state: step.value.checkpoint!, signalId: null, signalDate: null, lastProcessedDate: date };
          if (step.value.pendingEntry) signal = { state: step.value.checkpoint!,
            signalId: localSignalId(config.timeframe, sym.ticker, date, step.value.pendingEntry as 1 | 2), signalDate: date, lastProcessedDate: date };
          signal = { state: step.value.checkpoint!, signalId: signal?.signalId ?? null,
            signalDate: signal?.signalDate ?? null, lastProcessedDate: date };
        }
      }
    }
    const accountBuy1 = tracking ? inp.buy1.map(() => false) : inp.buy1;
    const accountBuy2 = tracking ? inp.buy2.map(() => false) : inp.buy2;
    // 下一根是否还允许执行旧买单，在生成器第一次 next 前确定。
    const firstNew = sym.axisIndex.findIndex((d) => !resume || uni.axis[d] > resume.asOf);
    const decision = { ...resume?.decisions[sym.ticker] };
    if (resume && firstNew >= 0 && opts.fillGate && !opts.fillGate(sym.ticker, uni.axis[sym.axisIndex[firstNew]])) decision.rejectEntry = true;
    return {
      idx,
      sym,
      shadow, signal, accountBuy1, accountBuy2, eligibleBuy1: inp.buy1, eligibleBuy2: inp.buy2,
      gen: rotationTradeSteps(
        sym.ticker,
        inp.bars,
        accountBuy1,
        accountBuy2,
        inp.rs,
        {
          ...tradeParamsOf(config),
          ...(opts.exitWindow === "dayClose"
            ? { exitGate: (k: number) => isDayClose[sym.axisIndex[k]] }
            : {}),
        },
        capture || resume ? { after: resume?.asOf, state: accountState, decision, capture } : undefined,
      ),
      cursor: resume ? (firstNew < 0 ? sym.axisIndex.length : firstNew) : 0,
      local: resume ? (firstNew < 0 ? sym.axisIndex.length : firstNew) - 1 : -1,
      view: null as StepView | null,
      state: accountState,
      lastClose: previous?.lastClose ?? 0,
      lastRps: previous?.lastRps ?? 0,
    };
  });

  const staleLegs = legs
    .map((leg) => ({ leg, end: leg.sym.axisIndex[leg.sym.axisIndex.length - 1] }))
    .filter(({ end }) => end < hi - 1);

  let cash = resume?.cash ?? 1;
  const slots = new Map<number, Slot>();
  const indices = new Map(legs.map((leg) => [leg.sym.ticker, leg.idx]));
  for (const [symbol, slot] of Object.entries(resume?.slots ?? {})) {
    const idx = indices.get(symbol);
    if (idx == null) throw new Error(`${symbol} 缺少持仓行情，不能继续记账`);
    slots.set(idx, { ...slot });
  }
  const lotPnl: { symbol: string; pct: number }[] = [];
  const trades: ClosedTrade[] = [];
  let orders: { idx: number; amount: number }[] = (resume?.orders ?? []).filter((o) => !delayedOrders.has(o.symbol))
    .map((o) => ({ idx: indices.get(o.symbol)!, amount: o.amount })).filter((o) => o.idx != null);
  const decisions = new Map<number, StepDecision>();
  for (const [symbol, decision] of Object.entries(resume?.decisions ?? {})) {
    const idx = indices.get(symbol);
    if (idx != null) decisions.set(idx, { ...decision });
  }

  const equity: number[] = [];
  const curve: { date: string; v: number }[] = [];
  const holdCounts: number[] = [];
  const book: DayBook[] = [];
  const holdings: HoldingDay[] = [];
  let entries = resume?.totals.entries ?? 0;
  let rotations = resume?.totals.rotations ?? 0;
  let missed = resume?.totals.missed ?? 0;
  let holdingSum = resume?.totals.holdingSum ?? 0;
  let exposureSum = resume?.totals.exposureSum ?? 0;
  let exits = resume?.totals.exits ?? 0;
  let wins = resume?.totals.wins ?? 0;
  const missedBuys: { date: string; symbol: string; price: number }[] = [];

  let lastEq = resume?.lastEq ?? 1;
  let seed = resume?.seed ?? opts.seed ?? 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let d = 0; d < hi; d += 1) {
    if (resume && uni.axis[d] <= resume.asOf) continue;
    const processed = new Set<number>();
    for (const leg of legs) {
      if (leg.cursor < leg.sym.axisIndex.length && leg.sym.axisIndex[leg.cursor] === d) {
        if (opts.fillGate && !opts.fillGate(leg.sym.ticker, uni.axis[d])) {
          decisions.set(leg.idx, { ...decisions.get(leg.idx), rejectEntry: true });
          decide(tracking?.accounts[leg.sym.ticker]?.signalId, "pool");
        }
        if (leg.shadow) {
          const priorSignal = leg.signal;
          const next = leg.shadow.next(); // Never pass a portfolio rejectEntry / forceExit here.
          if (!next.done) {
            const step = next.value;
            const date = uni.axis[d];
            leg.signal = { state: step.checkpoint!, signalId: priorSignal?.signalId ?? null,
              signalDate: priorSignal?.signalDate ?? null, lastProcessedDate: date };
            if (step.justClosed) { leg.signal.signalId = null; leg.signal.signalDate = null; }
            if (step.pendingEntry) {
              const kind = step.pendingEntry as 1 | 2;
              leg.signal.signalId = localSignalId(config.timeframe, leg.sym.ticker, date, kind);
              leg.signal.signalDate = date;
              if (d >= lo) record({ id: `${leg.signal.signalId}:buy`, signalId: leg.signal.signalId, symbol: leg.sym.ticker,
                type: "buy", signalDate: date, signalTime: localSignalTime(date, config.timeframe), signalTimeEstimated: true,
                entrySignalDate: date, signalPrice: leg.sym.close[leg.cursor], kind,
                status: "pending", reason: "accepted", rps: leg.sym.rps[leg.cursor] });
            }
            if (step.checkpoint?.pendingExit && leg.signal.signalId && !priorSignal?.state.pendingExit && d >= lo) {
              record({ id: `${leg.signal.signalId}:sell:${date}`, signalId: leg.signal.signalId, symbol: leg.sym.ticker,
                type: "sell", signalDate: date, signalTime: localSignalTime(date, config.timeframe), signalTimeEstimated: true,
                entrySignalDate: leg.signal.signalDate, signalPrice: leg.sym.close[leg.cursor], kind: step.day.sigType as 1 | 2,
                status: "observed", reason: step.checkpoint.pendingExit });
            }
            leg.accountBuy1[leg.cursor] = step.pendingEntry === 1 && leg.eligibleBuy1[leg.cursor];
            leg.accountBuy2[leg.cursor] = step.pendingEntry === 2 && leg.eligibleBuy2[leg.cursor];
          }
        }
        const r = leg.gen.next(decisions.get(leg.idx));
        processed.add(leg.idx);
        if (capture) decisions.delete(leg.idx);
        leg.view = r.done ? null : r.value;
        leg.state = leg.view?.checkpoint ?? leg.state;
        leg.local = leg.cursor;
        leg.cursor += 1;
        leg.lastClose = leg.sym.close[leg.local];
        if (leg.sym.rps[leg.local] >= 1) leg.lastRps = leg.sym.rps[leg.local];
        if (tracking && leg.signal?.state.pendingEntry && !leg.view?.pendingEntry && d >= lo) {
          const reason = (leg.view?.day.sigType ?? 0) !== 0 ? "holding" : leg.sym.rps[leg.local] < Math.max(1, config.rpsMin) ? "rps" : "eligibility";
          decide(leg.signal.signalId, reason);
          missed += 1;
        }
      } else {
        leg.view = null;
      }
    }
    if (!capture) decisions.clear();
    if (d < lo) continue;

    const sells: string[] = [];
    const closeSlot = (idx: number, price: number, trade: ClosedTrade | null) => {
      const slot = slots.get(idx);
      if (!slot) return;
      const proceeds = slot.shares * price * (1 - cost);
      cash += proceeds;
      exits += 1;
      if (proceeds > slot.cost) wins += 1;
      if (!statsOnly && slot.eqAtEntry > 0) {
        lotPnl.push({
          symbol: legs[idx].sym.ticker,
          pct: ((proceeds - slot.cost) / slot.eqAtEntry) * 100,
        });
      }
      if (!statsOnly && trade) trades.push(trade);
      if (!statsOnly) sells.push(legs[idx].sym.ticker);
      if (tracking) {
        const leg = legs[idx];
        const account = tracking.accounts[leg.sym.ticker];
        const signalId = account?.signalId ?? `legacy:${config.timeframe}:${leg.sym.ticker}:${slot.entryDate}`;
        const signalDate = trade && leg.local > 0 ? uni.axis[leg.sym.axisIndex[leg.local - 1]] : uni.axis[d];
        const buy = entryEvent(account?.signalId);
        record({ id: `${signalId}:account_exit:${uni.axis[d]}`, signalId, symbol: leg.sym.ticker, type: "account_exit",
          signalDate, signalTime: localSignalTime(signalDate, config.timeframe), signalTimeEstimated: true,
          entrySignalDate: buy?.signalDate ?? null, signalPrice: trade && leg.local > 0 ? leg.sym.close[leg.local - 1] : price,
          kind: slot.sigType, status: "exited", reason: trade?.exitReason ?? "missing_quote", fillDate: uni.axis[d], fillPrice: price });
        delete tracking.accounts[leg.sym.ticker];
      }
      slots.delete(idx);
    };

    for (const leg of legs) {
      const done = leg.view?.justClosed;
      if (!done) continue;
      closeSlot(leg.idx, done.exitPrice, done);
    }

    for (const { leg, end } of staleLegs) {
      if (opts.retainMissing) continue;
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
      if (tracking) {
        const event = entryEvent(tracking.accounts[leg.sym.ticker]?.signalId);
        if (event) { event.status = "bought"; event.fillDate = uni.axis[d]; event.fillPrice = price; }
      }
      if (!statsOnly) buys.push(leg.sym.ticker);
    }
    orders = capture ? orders.filter((o) => !processed.has(o.idx)) : [];

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
          rps: legs[idx].lastRps >= 1 ? legs[idx].lastRps : null,
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
      .sort((a, b) => b.rps - a.rps || (tracking ? a.leg.sym.ticker.localeCompare(b.leg.sym.ticker) : 0));
    if (fresh.length === 0) continue;

    if (opts.entryGate) {
      for (const cand of fresh) {
        if (!opts.entryGate(cand.leg.sym.ticker, date)) {
          decisions.set(cand.leg.idx, { rejectEntry: true });
          decide(cand.leg.signal?.signalId, "pool");
          missed += 1;
        }
      }
    }

    if (opts.entryWindow === "dayClose" && !isDayClose[d]) {
      for (const cand of fresh) {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        decide(cand.leg.signal?.signalId, "window");
        missed += 1;
      }
      continue;
    }

    const slotAmount = eq * (opts.slotPctOf ? opts.slotPctOf(date) : opts.slotPct);
    let free = cash - (capture ? orders.reduce((sum, o) => sum + o.amount, 0) : 0);
    const doomed = new Set<number>();

    for (const cand of fresh) {
      if (decisions.get(cand.leg.idx)?.rejectEntry) continue;
      const want = slotAmount * (opts.slotScale?.(cand.leg.sym.ticker, date) ?? 1);
      if (want <= 1e-9) {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        decide(cand.leg.signal?.signalId, "allocation");
        missed += 1;
        continue;
      }
      if (free >= want) {
        orders.push({ idx: cand.leg.idx, amount: want });
        if (tracking) tracking.accounts[cand.leg.sym.ticker] = { signalId: cand.leg.signal?.signalId ?? null, legacy: false };
        free -= want;
        continue;
      }

      const alive = [...slots.keys()].filter((i) => !doomed.has(i));
      if (opts.mode === "none" || alive.length === 0) {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        decide(cand.leg.signal?.signalId, "cash");
        missed += 1;
        if (!statsOnly && cand.leg.lastClose > 0) {
          missedBuys.push({ date, symbol: cand.leg.sym.ticker, price: cand.leg.lastClose });
        }
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
        if (tracking) tracking.accounts[cand.leg.sym.ticker] = { signalId: cand.leg.signal?.signalId ?? null, legacy: false };
        const victimValue = slots.get(victim)!.shares * legs[victim].lastClose;
        free += victimValue * (1 - cost) - slotAmount;
        rotations += 1;
      } else {
        decide(cand.leg.signal?.signalId, "cash");
        decisions.set(cand.leg.idx, { rejectEntry: true });
        missed += 1;
      }
    }
  }

  if (tracking) {
    tracking.asOf = curve.at(-1)?.date ?? resume?.asOf ?? "";
    for (const leg of legs) if (leg.signal) tracking.states[leg.sym.ticker] = leg.signal;
    for (const symbol of Object.keys(tracking.accounts)) {
      const idx = indices.get(symbol);
      if (idx != null && !slots.has(idx) && !orders.some(order => order.idx === idx)) delete tracking.accounts[symbol];
    }
  }
  const bars = (resume?.totals.bars ?? 0) + equity.length;
  const n = Math.max(1, bars);
  const byDay = new Map<string, number>((resume?.dailyEquity ?? []).map((p) => [p.date, p.v]));
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
    missedBuys,
    ...(capture ? { checkpoint: {
      version: 1 as const, asOf: curve.at(-1)?.date ?? resume?.asOf ?? "", cash, lastEq, seed,
      slots: Object.fromEntries([...slots].map(([idx, slot]) => [legs[idx].sym.ticker, slot])),
      legs: Object.fromEntries(legs.filter((leg) => leg.state && (slots.has(leg.idx) || orders.some((o) => o.idx === leg.idx))).map((leg) => [leg.sym.ticker, { state: leg.state!, lastClose: leg.lastClose, lastRps: leg.lastRps }])),
      orders: orders.map((o) => ({ symbol: legs[o.idx].sym.ticker, amount: o.amount })),
      decisions: Object.fromEntries([...decisions].filter(([idx]) => slots.has(idx) || orders.some((o) => o.idx === idx)).map(([idx, decision]) => [legs[idx].sym.ticker, decision])),
      dailyEquity: [...byDay].map(([date, v]) => ({ date, v })),
      ...(tracking ? { signalTracking: tracking } : {}),
      totals: { entries, rotations, missed, holdingSum, exposureSum, exits, wins, bars },
    } } : {}),
  };
}
