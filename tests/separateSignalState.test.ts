import { describe, expect, it } from "vitest";
import { runRotate } from "@/lib/fund/rotate";
import { rotateCheckpointOf } from "@/lib/fund/rotateCheckpoint";
import { axis, config, options, symbol, universe } from "./continuousBookFixtures";

const opts = { ...options, separateSignalState: true };
const prices = (drop = 80) => Array.from({ length: 80 }, (_, i) => i < drop ? 100 : 50);

describe("独立策略信号与账户执行", () => {
  it("RTX/GS：资金不足跳过一轮后，现金恢复及重复裸买条件都不能追补；新一轮才准入", () => {
    const holder = symbol("HOLD", [35], prices(48));
    const rtx = symbol("RTX", [36, 55, 65], prices(60));
    const uni = universe(holder, rtx);
    const legacy = runRotate(uni, config, { ...options, slotPct: 1 });
    expect(legacy.book.some(p => p.date === axis[56] && p.buys.includes("RTX"))).toBe(true);
    const fixed = runRotate(uni, config, { ...opts, slotPct: 1 });
    expect(fixed.book.filter(p => p.buys.includes("RTX")).map(p => p.date)).toEqual([axis[66]]);
    const buys = fixed.checkpoint!.signalTracking!.events.filter(e => e.symbol === "RTX" && e.type === "buy");
    expect(buys.map(e => [e.signalDate, e.status, e.reason])).toEqual([
      [axis[36], "skipped", "cash"], [axis[65], "bought", "accepted"],
    ]);
    expect(buys[1].fillDate).toBe(axis[66]);
    expect(rotateCheckpointOf(fixed.checkpoint)).toBe(fixed.checkpoint);
  });

  it("GOOG/CSCO：被股票池或RPS拒绝后保留策略轮次，重新入池/恢复强度不补买", () => {
    const goog = symbol("GOOG", [35, 50], prices());
    const csco = symbol("CSCO", [35, 50], prices());
    csco.rps[35] = 5;
    const fixed = runRotate(universe(goog, csco), { ...config, rpsMin: 30 }, {
      ...opts, entryGate: (s, d) => s !== "GOOG" || d >= axis[40],
    });
    expect(fixed.entries).toBe(0);
    expect(fixed.checkpoint!.signalTracking!.events.filter(e => e.type === "buy").map(e => [e.symbol, e.reason]).sort()).toEqual([["CSCO", "rps"], ["GOOG", "pool"]]);
    expect(fixed.checkpoint!.signalTracking!.states.GOOG.state.sigType).toBe(1);
    expect(fixed.checkpoint!.slots).toEqual({});
    expect(rotateCheckpointOf(JSON.parse(JSON.stringify(fixed.checkpoint)))).toBeTruthy();
  });

  it("2H账户RPS转弱退出不结束技术轮次，不允许同轮重新买入", () => {
    const rtx = symbol("RTX", [35, 50], prices());
    rtx.rps[40] = 5;
    const fixed = runRotate(universe(rtx), { ...config, timeframe: "2h", rpsExit: 10 }, opts);
    expect(fixed.entries).toBe(1);
    expect(fixed.trades).toHaveLength(1);
    expect(fixed.trades[0]).toMatchObject({ exitDate: axis[41], exitReason: "rsWeak" });
    expect(fixed.checkpoint!.signalTracking!.states.RTX.state.sigType).toBe(1);
    expect(fixed.checkpoint!.signalTracking!.events.find(e => e.type === "account_exit")).toMatchObject({ reason: "rsWeak", fillDate: axis[41], entrySignalDate: axis[35] });
  });

  it("JSON恢复、重复运行和挂单断点保持幂等，预留现金不会重复分配", () => {
    const uni = universe(symbol("AAPL", [35], prices()), symbol("NVDA", [35], prices()));
    const one = runRotate(uni, config, { ...opts, slotPct: 0.6 });
    const first = runRotate(uni, { ...config, to: axis[35] }, { ...opts, slotPct: 0.6 });
    expect(first.checkpoint!.orders).toHaveLength(1);
    expect(first.checkpoint!.signalTracking!.events.map(e => [e.symbol, e.status])).toEqual([["AAPL", "pending"], ["NVDA", "skipped"]]);
    const restored = rotateCheckpointOf(JSON.parse(JSON.stringify(first.checkpoint)));
    const next = runRotate(uni, config, { ...opts, slotPct: 0.6, continuation: { capture: true, checkpoint: restored } });
    expect(next.checkpoint).toEqual(one.checkpoint);
    const again = runRotate(uni, config, { ...opts, slotPct: 0.6, continuation: { capture: true, checkpoint: next.checkpoint } });
    expect(again.book).toEqual([]);
    expect(again.checkpoint).toEqual(next.checkpoint);
  });

  it("旧GS持仓保留原价/现金/退出保护，仅标legacy；重放shadow不回写历史", () => {
    const uni = universe(symbol("HOLD", [35], prices(48)), symbol("GS", [36, 55], prices(68)));
    const old = runRotate(uni, { ...config, to: axis[58] }, { ...options, slotPct: 1 });
    expect(old.checkpoint!.slots.GS.entryDate).toBe(axis[56]);
    const saved = JSON.parse(JSON.stringify(old.checkpoint));
    const migrated = runRotate(uni, { ...config, to: axis[58] }, { ...opts, slotPct: 1, continuation: { checkpoint: old.checkpoint, capture: true } });
    expect(migrated.book).toEqual([]);
    expect(migrated.trades).toEqual([]);
    expect(migrated.checkpoint!.cash).toBe(saved.cash);
    expect(migrated.checkpoint!.dailyEquity).toEqual(saved.dailyEquity);
    expect(migrated.checkpoint!.slots).toEqual(saved.slots);
    expect(migrated.checkpoint!.legs).toEqual(saved.legs);
    expect(migrated.checkpoint!.signalTracking!.accounts.GS).toEqual({ signalId: null, legacy: true });
    expect(migrated.checkpoint!.signalTracking!.states.GS.signalDate).toBe(axis[36]);
    expect(old.checkpoint).toEqual(saved);
    expect(rotateCheckpointOf(migrated.checkpoint)).toBeTruthy();
    const next = runRotate(uni, config, { ...opts, slotPct: 1, continuation: { checkpoint: migrated.checkpoint, capture: true } });
    expect(next.trades).toHaveLength(1);
    expect(next.trades[0]).toMatchObject({ symbol: "GS", entryDate: axis[56], exitDate: axis[69], exitReason: "stop" });
  });

  it("新增股票先恢复过去信号轮次，不从空状态伪造新买点", () => {
    const first = runRotate(universe(symbol("AAPL", [], prices())), { ...config, to: axis[45] }, opts);
    const next = runRotate(universe(symbol("AAPL", [], prices()), symbol("GOOG", [35, 55], prices())), config, {
      ...opts, continuation: { checkpoint: first.checkpoint, capture: true },
    });
    expect(next.entries).toBe(0);
    expect(next.checkpoint!.signalTracking!.states.GOOG.signalDate).toBe(axis[35]);
    expect(next.checkpoint!.signalTracking!.events.filter(e => e.symbol === "GOOG")).toEqual([]);
  });

  it("待买股票在成交前移出池子，永久记录取消原因，不污染独立信号", () => {
    const uni = universe(symbol("AAPL", [35, 55], prices()));
    const first = runRotate(uni, { ...config, to: axis[35] }, opts);
    const next = runRotate(uni, config, { ...opts, fillGate: (_, d) => d !== axis[36],
      continuation: { checkpoint: first.checkpoint, capture: true } });
    expect(next.entries).toBe(0);
    expect(next.checkpoint!.signalTracking!.events[0]).toMatchObject({ status: "skipped", reason: "pool" });
    expect(next.checkpoint!.signalTracking!.states.AAPL.state.sigType).toBe(1);
    expect(next.checkpoint!.signalTracking!.accounts).toEqual({});
  });

  it("断点在卖点根时，续算退出仍关联原买点；同根新轮与旧退出不会混连", () => {
    const uni = universe(symbol("RTX", [35, 51], prices(50)));
    const first = runRotate(uni, { ...config, to: axis[50] }, opts);
    const tracking = first.checkpoint!.signalTracking!;
    expect(tracking.states.RTX.state.pendingExit).toBe("stop");
    const originalId = tracking.states.RTX.signalId;
    const next = runRotate(uni, config, { ...opts, continuation: { checkpoint: rotateCheckpointOf(JSON.parse(JSON.stringify(first.checkpoint))), capture: true } });
    const events = next.checkpoint!.signalTracking!.events;
    expect(events.filter(e => e.type === "sell" && e.signalId === originalId)).toHaveLength(1);
    expect(events.find(e => e.type === "account_exit" && e.signalId === originalId)).toMatchObject({ signalDate: axis[50], entrySignalDate: axis[35], fillDate: axis[51] });
    const newBuy = events.find(e => e.type === "buy" && e.signalDate === axis[51]);
    expect(newBuy).toMatchObject({ status: "bought", fillDate: axis[52] });
    expect(newBuy!.signalId).not.toBe(originalId);
    expect(next.checkpoint!.signalTracking!.accounts.RTX.signalId).toBe(newBuy!.signalId);
  });

  it("已保存信号参数变化时停止，不能沿用旧状态却对账成新参数", () => {
    const uni = universe(symbol("AAPL", [35], prices()));
    const first = runRotate(uni, { ...config, to: axis[40] }, opts);
    const saved = JSON.stringify(first.checkpoint);
    expect(() => runRotate(uni, { ...config, trailMult: 99 }, { ...opts, continuation: { checkpoint: first.checkpoint, capture: true } })).toThrow("参数已变化");
    expect(JSON.stringify(first.checkpoint)).toBe(saved);
  });

  it("恢复校验拒绝丢失策略轮次ID或账户关联，研究回测默认不变", () => {
    const uni = universe(symbol("AAPL", [35], prices()));
    const raw = runRotate(uni, config, options);
    expect(raw.checkpoint!.signalTracking).toBeUndefined();
    const fixed = runRotate(uni, config, opts);
    const bad = structuredClone(fixed.checkpoint!);
    bad.signalTracking!.states.AAPL.signalId = null;
    expect(() => rotateCheckpointOf(bad)).toThrow("恢复状态无效");
    const missing = structuredClone(fixed.checkpoint!);
    delete missing.signalTracking!.accounts.AAPL;
    expect(() => rotateCheckpointOf(missing)).toThrow("恢复状态无效");
  });
});
