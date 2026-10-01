import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPreparedUniverse } from "@/lib/backtest/load";
import { champOf } from "@/lib/fund/champs";
import { runRotate } from "@/lib/fund/rotate";
import { lookbackView } from "@/lib/fund/lookbackLogic";
import { runContinuousBook } from "@/lib/fund/liveBookContinuation";
import { withBookCurve } from "@/lib/fund/liveBookCurve";
import { slimLookbackView } from "@/lib/fund/liveBooksLogic";
import { axis, symbol, universe } from "./continuousBookFixtures";

vi.mock("@/lib/backtest/load", () => ({ getPreparedUniverse: vi.fn() }));
const champ = champOf("4h");
const baseline = () => {
  const raw = runRotate(universe(symbol("AAPL")), { ...champ.config, from: axis[30], to: axis[45] }, { ...champ.opts, slotPct: 0.1 });
  return { tf: "4h" as const, name: "4 小时", view: lookbackView(raw, axis[30]) };
};
const input = () => ({ tf: "4h" as const, from: axis[30], slots: 10, members: ["NVDA"], priorMembers: ["AAPL"], previous: baseline(),
  history: [{ id: "baseline", effectiveAt: "", members: ["AAPL"] }, { id: "new", effectiveAt: `${axis[50]}:00Z`, members: ["NVDA"] }] });
beforeEach(() => vi.mocked(getPreparedUniverse).mockResolvedValue(universe(symbol("AAPL"), symbol("NVDA", [40, 55]))));

describe("旧账本衔接与历史冻结", () => {
  it("升级已有盈利账本，保持旧曲线和成交，新增标的不追溯历史买点", async () => {
    const request = input();
    const result = await runContinuousBook(request);
    expect(result.view.curve.slice(0, request.previous.view.curve.length)).toEqual(request.previous.view.curve);
    expect(result.view.fills.filter((f) => f.date <= request.previous.view.asOf)).toEqual(request.previous.view.fills);
    // NVDA 在入池前已开始一轮信号；加入池子/账户空仓不能让第55根另开一笔。
    expect(result.view.fills.find((f) => f.symbol === "NVDA")).toBeUndefined();
    expect(result.checkpoint.signalTracking?.states.NVDA.state.sigType).not.toBe(0);
    expect(result.checkpoint.slots.AAPL.entryDate).toBe(axis[36]);
    expect(result.checkpoint.lastEq).toBe(result.view.equity);
  });

  it("没有新 K 线只补齐恢复状态，原结果逐字段保持不变", async () => {
    vi.mocked(getPreparedUniverse).mockResolvedValue({ ...universe(symbol("AAPL"), symbol("NVDA")), axis: axis.slice(0, 46),
      symbols: [symbol("AAPL", [35], undefined, 46), symbol("NVDA", [], undefined, 46)] });
    const previous = baseline();
    const result = await runContinuousBook({ ...input(), previous });
    expect(result.view).toEqual(previous.view);
    expect(result.checkpoint.lastEq).toBe(previous.view.equity);
    expect(result.checkpoint.signalTracking?.migration.positions).toEqual([
      expect.objectContaining({ symbol: "AAPL", entryDate: axis[36], reason: "legacy" }),
    ]);
  });

  it("旧版仅存最后一天时，即使没有新行情也恢复全部历史净值", async () => {
    vi.mocked(getPreparedUniverse).mockResolvedValue({ ...universe(symbol("AAPL")), axis: axis.slice(0, 46), symbols: [symbol("AAPL", [35], undefined, 46)] });
    const previous = baseline(), full = previous.view.curve;
    previous.view = { ...previous.view, curve: full.slice(-1) };
    const result = await runContinuousBook({ ...input(), previous });
    expect(result.view.curve.map((p) => [p.date, p.equity])).toEqual(full.map((p) => [p.date, p.equity]));
    expect({ ...result.view, curve: [] }).toEqual({ ...previous.view, curve: [] });
  });

  it("同一截止时间新增股票也恢复其信号状态，不改历史账户", async () => {
    const small = { axis: axis.slice(0, 46), symbols: [symbol("AAPL", [35], undefined, 46)] };
    vi.mocked(getPreparedUniverse).mockResolvedValue(small);
    const first = await runContinuousBook({ ...input(), members: ["AAPL"] });
    vi.mocked(getPreparedUniverse).mockResolvedValue({ ...small, symbols: [...small.symbols, symbol("NVDA", [40], undefined, 46)] });
    const result = await runContinuousBook({ ...input(), previous: { ...baseline(), ...first } });
    expect(result.view).toEqual(first.view);
    expect(result.checkpoint.slots).toEqual(first.checkpoint.slots);
    expect(result.checkpoint.cash).toBe(first.checkpoint.cash);
    expect(result.checkpoint.signalTracking?.states.NVDA.signalDate).toBe(axis[40]);
    expect(result.checkpoint.signalTracking?.events).toEqual(first.checkpoint.signalTracking?.events);
  });

  it("全局截止时间不变、个股尾部行情补齐时仍推进该票的独立状态", async () => {
    const partial = { axis: axis.slice(0, 51), symbols: [symbol("AAPL", [35], undefined, 51), symbol("NVDA", [35], undefined, 40)] };
    vi.mocked(getPreparedUniverse).mockResolvedValue(partial);
    const first = await runContinuousBook(input());
    vi.mocked(getPreparedUniverse).mockResolvedValue({ ...partial, symbols: [partial.symbols[0], symbol("NVDA", [35], undefined, 51)] });
    const next = await runContinuousBook({ ...input(), previous: { ...baseline(), ...first } });
    expect(next.checkpoint.signalTracking!.states.NVDA.lastProcessedDate).toBe(axis[50]);
    expect(next.view).toEqual(first.view);
    expect(next.checkpoint.slots).toEqual(first.checkpoint.slots);
    expect(next.checkpoint.cash).toBe(first.checkpoint.cash);
    expect(next.checkpoint.signalTracking!.events).toEqual(first.checkpoint.signalTracking!.events);
  });

  it.each(["4h", "2h"] as const)("%s 连续多日定时更新、序列化保存和同日重跑始终保留完整曲线", async (tf) => {
    const config = champOf(tf === "2h" ? "2h-broad" : "4h").config;
    const opts = { ...champ.opts, slotPct: 0.1, continuation: { capture: true } };
    const first = runRotate(universe(symbol("AAPL")), { ...config, from: axis[30], to: axis[45] }, opts);
    let previous = { tf, name: tf, view: lookbackView(first, axis[30]), checkpoint: first.checkpoint!, sparkline: [first.checkpoint!.lastEq] };
    previous.view.curve = previous.view.curve.slice(-1);
    for (let n = 46; n <= 60; n++) {
      vi.mocked(getPreparedUniverse).mockResolvedValue({ axis: axis.slice(0, n), symbols: [symbol("AAPL", [35], undefined, n)] });
      const request = { tf, from: axis[30], slots: 10, members: ["AAPL"], priorMembers: ["AAPL"],
        history: [{ id: "base", effectiveAt: "", members: ["AAPL"] }], previous };
      const result = await runContinuousBook(request);
      expect(result.view.curve).toHaveLength(n - 30);
      expect(result.view.curve.map((p) => ({ date: p.date, v: p.equity }))).toEqual(result.checkpoint.dailyEquity);
      expect(result.checkpoint.dailyEquity.slice(0, previous.checkpoint.dailyEquity.length)).toEqual(previous.checkpoint.dailyEquity);
      const stored = withBookCurve({ tf, name: tf, checkpoint: result.checkpoint, view: slimLookbackView(result.view) });
      expect(stored.sparkline).toHaveLength(Math.min(40, n - 30));
      expect(stored.sparkline!.at(-1)).toBe(stored.view.equity);
      previous = JSON.parse(JSON.stringify(stored));
      const repeated = await runContinuousBook({ ...request, previous });
      expect(repeated).toEqual({ view: previous.view, checkpoint: previous.checkpoint });
    }
  });

  it("旧成绩无法复原时拒绝迁移，不把新测算当成原成绩", async () => {
    const request = input();
    request.previous.view.equity += 0.1;
    await expect(runContinuousBook(request)).rejects.toThrow("无法按原池子");
  });

  it("再次更新不重复成交，历史行情修订也不改变已存曲线", async () => {
    const first = await runContinuousBook(input());
    const changed = symbol("AAPL");
    changed.close[40] = 1;
    vi.mocked(getPreparedUniverse).mockResolvedValue(universe(changed, symbol("NVDA", [40, 55])));
    const next = await runContinuousBook({ ...input(), previous: { ...baseline(), ...first }, priorMembers: ["NVDA"] });
    expect(next).toEqual(first);
  });

  it("即使没有新行情也不能把旧信号参数标成当前配置", async () => {
    const first = await runContinuousBook(input());
    first.checkpoint.signalTracking!.parameters.stopMult += 1;
    const saved = structuredClone(first);
    await expect(runContinuousBook({ ...input(), previous: { ...baseline(), ...first } })).rejects.toThrow("参数已变化");
    expect(first).toEqual(saved);
  });

  it("显式新建一期才从初始权益重新计算", async () => {
    const result = await runContinuousBook({ ...input(), from: axis[60], previous: undefined, priorMembers: undefined });
    expect(result.view.equity).toBe(1);
    expect(result.view.fills).toEqual([]);
    expect(result.view.since).toBe(axis[60]);
  });
});
