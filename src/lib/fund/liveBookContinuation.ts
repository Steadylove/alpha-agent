import { getPreparedUniverse } from "@/lib/backtest/load";
import type { PreparedUniverse } from "@/lib/backtest/engine";
import { champOf } from "./champs";
import { lookbackView, type LookbackTf, type LookbackView } from "./lookbackLogic";
import type { LiveBookOk } from "./liveBooksLogic";
import { poolAt, type PoolRevision } from "./poolTimeline";
import { runRotate, type RotateCheckpoint } from "./rotate";
import { rotateCheckpointOf } from "./rotateCheckpoint";
import { restoreBookCurve } from "./liveBookCurve";

export function appendBookView(previous: LookbackView, next: LookbackView, checkpoint: RotateCheckpoint): LookbackView {
  const days = new Map(previous.curve.map((p) => [p.date, p]));
  for (const p of next.curve) {
    const old = days.get(p.date);
    days.set(p.date, old ? { ...p, buys: [...new Set([...old.buys, ...p.buys])], sells: [...new Set([...old.sells, ...p.sells])] } : p);
  }
  const fills = new Map(previous.fills.map((f) => [`${f.date}:${f.symbol}:${f.side}`, f]));
  for (const fill of next.fills) {
    const key = `${fill.date}:${fill.symbol}:${fill.side}`;
    if (!fills.has(key)) fills.set(key, fill);
  }
  const curve = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const merged = restoreBookCurve({ ...next, since: previous.since, curve,
    fills: [...fills.values()].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol) || a.side.localeCompare(b.side)) }, checkpoint);
  // YTD 要以整条已记账曲线的年初净值计算。
  const year = Number(next.asOf.slice(0, 4));
  const base = merged.curve.filter((p) => Number(p.date.slice(0, 4)) < year).at(-1)?.equity ?? 1;
  merged.stats = { ...next.stats, ytdYear: year, ytdPct: (next.equity / base - 1) * 100,
    winRatePct: checkpoint.totals.exits ? checkpoint.totals.wins / checkpoint.totals.exits * 100 : null };
  return merged;
}

function assertSameBaseline(previous: LookbackView, rebuilt: LookbackView): void {
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a));
  const rows = new Map(rebuilt.rows.map((r) => [r.symbol, r]));
  const agrees = previous.asOf === rebuilt.asOf && close(previous.equity, rebuilt.equity) && previous.rows.length === rebuilt.rows.length &&
    previous.rows.every((r) => {
      const b = rows.get(r.symbol);
      return b && r.entryDate === b.entryDate && close(r.entryPrice, b.entryPrice) && close(r.weightPct, b.weightPct) && close(r.floatPnlPct, b.floatPnlPct);
    }) && previous.curve.every((p) => {
      const b = rebuilt.curve.find((r) => r.date === p.date);
      return b && close(p.equity, b.equity);
    });
  if (!agrees) throw new Error("旧账本无法按原池子和原截止时间复原，已保留原成绩，请检查历史行情或策略版本");
}

/** 首次升级只复原内部状态并核对，绝不把重新计算的成绩替换旧成绩。 */
function migrateCheckpoint(uni: PreparedUniverse, tf: LookbackTf, previous: LiveBookOk, priorMembers: readonly string[], slots: number): RotateCheckpoint {
  const champ = champOf(tf === "2h" ? "2h-broad" : "4h");
  const allow = new Set(priorMembers);
  const raw = runRotate({ ...uni, symbols: uni.symbols.filter((s) => allow.has(s.ticker)) },
    { ...champ.config, from: previous.view.since, to: previous.view.asOf },
    { ...champ.opts, slotPct: 1 / slots, continuation: { capture: true } });
  assertSameBaseline(previous.view, lookbackView(raw, previous.view.since));
  const checkpoint = raw.checkpoint!;
  checkpoint.cash += previous.view.equity - checkpoint.lastEq;
  checkpoint.lastEq = previous.view.equity;
  const oldEquity = new Map(previous.view.curve.map((p) => [p.date, p.equity]));
  checkpoint.dailyEquity = checkpoint.dailyEquity.map((p) => ({ ...p, v: oldEquity.get(p.date) ?? p.v }));
  // 旧回测会将数据结束的标的按末价清仓，生成器仍可能留有该票状态。
  for (const [symbol, leg] of Object.entries(checkpoint.legs)) {
    if (!checkpoint.slots[symbol] && leg.state.sigType) {
      leg.state = { ...leg.state, sigType: 0, entryPrice: null, entryDate: null, stopLevel: null, trailLevel: null,
        highWater: 0, maxPnlPct: 0, initialRisk: 0, pendingExit: null, pendingEntry: 0, entryRps: null };
    }
  }
  return rotateCheckpointOf(checkpoint);
}

export async function runContinuousBook(input: {
  tf: LookbackTf; from: string; members: string[]; slots: number; history: PoolRevision[];
  previous?: LiveBookOk; priorMembers?: string[];
}): Promise<{ view: LookbackView; checkpoint: RotateCheckpoint }> {
  const { tf, from, members, slots, history, previous } = input;
  const champ = champOf(tf === "2h" ? "2h-broad" : "4h");
  // 持仓和已挂单即使已被移出池子，也必须继续取行情并管理退出。
  const wanted = [...new Set([
    ...members, ...(previous ? history.flatMap((r) => r.members) : []), ...(input.priorMembers ?? []),
    ...Object.keys(previous?.checkpoint?.slots ?? {}), ...(previous?.checkpoint?.orders.map((o) => o.symbol) ?? []),
  ])].sort();
  if (!wanted.length) throw new Error("请先纳入股票后建立账本");
  const uni = await getPreparedUniverse("SMALLFUND", champ.config.timeframe, champ.poolId, wanted);
  const to = uni.axis.at(-1);
  if (!to) throw new Error("没有可用行情，原成绩未覆盖");
  let checkpoint = previous?.checkpoint;
  if (previous && !checkpoint) {
    const oldMembers = input.priorMembers ?? members;
    const oldUniverse = await getPreparedUniverse("SMALLFUND", champ.config.timeframe, champ.poolId, oldMembers);
    checkpoint = migrateCheckpoint(oldUniverse, tf, previous, oldMembers, slots);
  }
  if (checkpoint && to < checkpoint.asOf) throw new Error("行情早于已记账时间，原成绩未覆盖");
  if (checkpoint && previous && to === checkpoint.asOf) return { view: restoreBookCurve(previous.view, checkpoint), checkpoint };
  const raw = runRotate(uni, { ...champ.config, from, to }, {
    ...champ.opts, slotPct: 1 / slots, retainMissing: true,
    continuation: { checkpoint, capture: true },
    ...(previous ? { entryGate: (ticker: string, date: string) => poolAt(history, date).includes(ticker),
      fillGate: (ticker: string, date: string) => poolAt(history, date).includes(ticker) } : {}),
  });
  const next = lookbackView(raw, from);
  const saved = rotateCheckpointOf(raw.checkpoint);
  return { view: previous ? appendBookView(previous.view, next, saved) : next, checkpoint: saved };
}
