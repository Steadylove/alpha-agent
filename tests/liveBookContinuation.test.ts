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
    expect(result.view.fills.find((f) => f.symbol === "NVDA")?.date).toBe(axis[56]);
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
  });

  it("旧版仅存最后一天时，即使没有新行情也恢复全部历史净值", async () => {
    vi.mocked(getPreparedUniverse).mockResolvedValue({ ...universe(symbol("AAPL")), axis: axis.slice(0, 46), symbols: [symbol("AAPL", [35], undefined, 46)] });
    const previous = baseline(), full = previous.view.curve;
    previous.view = { ...previous.view, curve: full.slice(-1) };
    const result = await runContinuousBook({ ...input(), previous });
    expect(result.view.curve.map((p) => [p.date, p.equity])).toEqual(full.map((p) => [p.date, p.equity]));
    expect({ ...result.view, curve: [] }).toEqual({ ...previous.view, curve: [] });
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

  it("显式新建一期才从初始权益重新计算", async () => {
    const result = await runContinuousBook({ ...input(), from: axis[60], previous: undefined, priorMembers: undefined });
    expect(result.view.equity).toBe(1);
    expect(result.view.fills).toEqual([]);
    expect(result.view.since).toBe(axis[60]);
  });
});
