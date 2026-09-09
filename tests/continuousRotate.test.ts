import { describe, expect, it } from "vitest";
import { runRotate } from "@/lib/fund/rotate";
import { rotateCheckpointOf } from "@/lib/fund/rotateCheckpoint";
import { poolAt } from "@/lib/fund/poolTimeline";
import { axis, config, options, symbol, universe } from "./continuousBookFixtures";

describe("连续现金账本", () => {
  it("跨进程 JSON 恢复后，与一次性计算的现金、持仓、风控和统计一致", () => {
    const uni = universe(symbol("AAPL"), symbol("NVDA", [48]));
    const all = runRotate(uni, config, options);
    const first = runRotate(uni, { ...config, to: axis[45] }, options);
    const checkpoint = rotateCheckpointOf(JSON.parse(JSON.stringify(first.checkpoint)));
    const next = runRotate(uni, config, { ...options, continuation: { capture: true, checkpoint } });
    expect([...first.book, ...next.book]).toEqual(all.book);
    expect(next.checkpoint).toEqual(all.checkpoint);
    expect(next.entries).toBe(2);
    expect(next.avgExposure).toBe(all.avgExposure);
    expect(next.dd).toBe(all.dd);
  });

  it("断在点火收盘时，待买单只在下一根成交一次", () => {
    const uni = universe(symbol("AAPL"));
    const first = runRotate(uni, { ...config, to: axis[35] }, options);
    expect(first.checkpoint?.orders).toHaveLength(1);
    expect(first.entries).toBe(0);
    const next = runRotate(uni, config, { ...options, continuation: { checkpoint: first.checkpoint, capture: true } });
    expect(next.book[0].buys).toEqual(["AAPL"]);
    expect(next.entries).toBe(1);
    expect(next.checkpoint).toEqual(runRotate(uni, config, options).checkpoint);
  });

  it("移出的待买单取消；已有持仓不因移出而消失，仍按止损退出", () => {
    const prices = Array.from({ length: 80 }, (_, i) => i < 50 ? 100 : 70);
    const uni = universe(symbol("AAPL", [35, 55], prices), symbol("NVDA", [40, 55]));
    const first = runRotate(uni, { ...config, to: axis[45] }, { ...options, entryGate: (s) => s === "AAPL" });
    const history = [{ id: "base", effectiveAt: "", members: ["AAPL"] }, { id: "change", effectiveAt: `${axis[46]}:00Z`, members: ["NVDA"] }];
    const next = runRotate(uni, config, { ...options, continuation: { capture: true, checkpoint: first.checkpoint },
      entryGate: (s, d) => poolAt(history, d).includes(s), fillGate: (s, d) => poolAt(history, d).includes(s) });
    expect(next.book[0].nHold).toBe(1);
    expect(next.book[0].buys).toEqual([]);
    expect(next.trades[0]).toMatchObject({ symbol: "AAPL", exitDate: axis[51], exitReason: "stop" });
    expect(next.book.filter((b) => b.buys.includes("AAPL"))).toEqual([]);
    expect(next.book.find((b) => b.buys.includes("NVDA"))?.date).toBe(axis[56]);
    const pending = runRotate(universe(symbol("AAPL")), { ...config, to: axis[35] }, options);
    const canceled = runRotate(universe(symbol("AAPL")), config, { ...options,
      continuation: { capture: true, checkpoint: pending.checkpoint }, entryGate: () => false, fillGate: () => false });
    expect(canceled.entries).toBe(0);
    expect(canceled.checkpoint?.cash).toBe(1);
  });

  it("止损指令跨重启保留，在下一根开盘执行", () => {
    const prices = Array.from({ length: 80 }, (_, i) => i < 50 ? 100 : i === 50 ? 70 : 60);
    const uni = universe(symbol("AAPL", [35], prices));
    const first = runRotate(uni, { ...config, to: axis[50] }, options);
    expect(first.checkpoint?.legs.AAPL.state.pendingExit).toBe("stop");
    const next = runRotate(uni, config, { ...options, continuation: { capture: true, checkpoint: first.checkpoint } });
    expect(next.trades[0]).toMatchObject({ exitPrice: 60, exitDate: axis[51] });
    expect(next.checkpoint).toEqual(runRotate(uni, config, options).checkpoint);
  });

  it("持仓后续报价缺失时不按最后价格虚构平仓", () => {
    const first = runRotate(universe(symbol("AAPL")), { ...config, to: axis[45] }, options);
    const next = runRotate(universe(symbol("AAPL", [35], undefined, 46), symbol("NVDA", [])), config,
      { ...options, continuation: { capture: true, checkpoint: first.checkpoint } });
    expect(next.checkpoint?.slots.AAPL).toEqual(first.checkpoint?.slots.AAPL);
    expect(next.checkpoint?.lastEq).toBe(first.checkpoint?.lastEq);
    expect(next.trades).toEqual([]);
  });

  it("已记账历史行情后来改变，也不会回写现金和历史成绩", () => {
    const first = runRotate(universe(symbol("AAPL")), { ...config, to: axis[45] }, options);
    const changed = symbol("AAPL");
    changed.close[40] = 1;
    const next = runRotate(universe(changed), { ...config, to: axis[46] }, { ...options, continuation: { capture: true, checkpoint: first.checkpoint } });
    expect(next.book.map((b) => b.date)).toEqual([axis[46]]);
    expect(next.checkpoint?.dailyEquity.slice(0, -1)).toEqual(first.checkpoint?.dailyEquity);
    expect(next.checkpoint?.slots.AAPL.entryPrice).toBe(first.checkpoint?.slots.AAPL.entryPrice);
  });
});
