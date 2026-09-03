import { describe, expect, it } from "vitest";

import {
  cashOf,
  equityOf,
  realizedPnl,
  type FundBook,
  type FundLot,
} from "@/lib/fund/bookLogic";
import { planDay, type PlanPosition, type PlanSignal } from "@/lib/fund/plan";

const lot = (symbol: string, over: Partial<FundLot> = {}): FundLot => ({
  id: `${symbol}|2026-01-02`,
  symbol,
  timeframe: "1d",
  sigType: 1,
  entryDate: "2026-01-02",
  entryPrice: 100,
  shares: 1.25,
  cost: 125,
  entryRps: 70,
  ...over,
});

const pos = (symbol: string, rps: number, over: Partial<PlanPosition> = {}): PlanPosition => ({
  lot: lot(symbol),
  close: 100,
  rps,
  effectiveStop: 90,
  stopHit: false,
  ...over,
});

const book = (lots: FundLot[], cash = 1000): FundBook => ({
  cashFlows: [{ date: "2026-01-01", amount: cash }],
  lots,
});

const sig = (symbol: string, rps: number): PlanSignal => ({
  symbol,
  sigType: 1,
  rps,
  close: 50,
});

describe("资金账本", () => {
  it("现金由流水推算，不单独记账", () => {
    const b = book([lot("AAA"), lot("BBB", { exit: { date: "2026-02-01", price: 120, proceeds: 150, reason: "stop" } })]);
    // 1000 注资 − 125 − 125 + 150
    expect(cashOf(b)).toBeCloseTo(900, 6);
    expect(realizedPnl(b)).toBeCloseTo(25, 6);
  });

  it("取不到报价的持仓按成本计，不用猜的价去标记", () => {
    const b = book([lot("AAA"), lot("BBB")]);
    const eq = equityOf(b, new Map([["AAA", 200]]));
    // 现金 750 + AAA 1.25×200 + BBB 按成本 125
    expect(eq).toBeCloseTo(750 + 250 + 125, 6);
  });
});

describe("每日清单", () => {
  it("现金够就直接买，金额为权益乘每笔比例", () => {
    const b = book([]);
    const plan = planDay({
      asOf: "2026-03-02",
      positions: [],
      signals: [sig("AAA", 80)],
      book: b,
      cash: 1000,
      equity: 1000,
      rules: { slotPct: 0.125, rotateEdge: null },
    });
    expect(plan.buys).toHaveLength(1);
    expect(plan.buys[0]).toMatchObject({ symbol: "AAA", amount: 125 });
    expect(plan.sells).toHaveLength(0);
  });

  it("跌破生效止损的持仓先卖，腾出的钱同日可用于建仓", () => {
    const b = book([lot("OLD")], 0);
    const plan = planDay({
      asOf: "2026-03-02",
      positions: [pos("OLD", 60, { stopHit: true, close: 96 })],
      signals: [sig("NEW", 65)],
      book: b,
      cash: 0,
      equity: 1000,
      rules: { slotPct: 0.125, rotateEdge: 20 },
    });
    expect(plan.sells).toHaveLength(1);
    expect(plan.sells[0]).toMatchObject({ symbol: "OLD", reason: "stop" });
    // 回收 1.25×96 = 120，仍不足一笔 125；且唯一持仓已在卖出单里，无可置换对象
    expect(plan.buys).toHaveLength(0);
    expect(plan.passes[0].why).toContain("无可置换持仓");
  });

  it("满仓且新信号明显更强时置换掉最弱的那只", () => {
    const b = book([lot("W"), lot("S")], 0);
    const plan = planDay({
      asOf: "2026-03-02",
      positions: [pos("W", 40), pos("S", 90)],
      signals: [sig("NEW", 75)],
      book: b,
      cash: 0,
      equity: 1000,
      rules: { slotPct: 0.125, rotateEdge: 20 },
    });
    expect(plan.sells).toHaveLength(1);
    expect(plan.sells[0]).toMatchObject({ symbol: "W", reason: "rotate", replacedBy: "NEW" });
    expect(plan.buys[0]).toMatchObject({ symbol: "NEW", replaces: "W" });
  });

  it("默认不置换：满仓时放弃信号，哪怕它比最弱持仓强得多", () => {
    // 置换在四个周期上实测都是负担（日线不置换 0.68，置换 +0/+10/+20 只有 0.44/0.20/0.45），
    // 所以默认关闭。上一条那种置换行为现在只有显式传 rotateEdge 才会发生。
    const b = book([lot("W"), lot("S")], 0);
    const plan = planDay({
      asOf: "2026-03-02",
      positions: [pos("W", 40), pos("S", 90)],
      signals: [sig("NEW", 95)],
      book: b,
      cash: 0,
      equity: 1000,
    });
    expect(plan.sells).toHaveLength(0);
    expect(plan.buys).toHaveLength(0);
    expect(plan.passes[0]).toMatchObject({ symbol: "NEW", why: "满仓，不置换" });
  });

  it("默认每笔 12.5%", () => {
    const plan = planDay({
      asOf: "2026-03-02",
      positions: [],
      signals: [sig("AAA", 80)],
      book: book([]),
      cash: 1000,
      equity: 1000,
    });
    expect(plan.slotAmount).toBeCloseTo(125, 6);
    expect(plan.buys[0]).toMatchObject({ symbol: "AAA", amount: 125 });
  });

  it("没超过门槛就放弃，不做无谓换手", () => {
    const b = book([lot("W")], 0);
    const plan = planDay({
      asOf: "2026-03-02",
      positions: [pos("W", 60)],
      signals: [sig("NEW", 75)],
      book: b,
      cash: 0,
      equity: 1000,
      rules: { slotPct: 0.125, rotateEdge: 20 },
    });
    // 75 未超过 60+20
    expect(plan.sells).toHaveLength(0);
    expect(plan.buys).toHaveLength(0);
    expect(plan.passes[0].why).toContain("最弱持仓 W");
  });

  it("同一只不会因为又出信号而重复买", () => {
    const b = book([lot("AAA")]);
    const plan = planDay({
      asOf: "2026-03-02",
      positions: [pos("AAA", 80)],
      signals: [sig("AAA", 85)],
      book: b,
      cash: 1000,
      equity: 1000,
    });
    expect(plan.buys).toHaveLength(0);
    expect(plan.passes[0]).toMatchObject({ symbol: "AAA", why: "已持仓" });
  });

  it("现金有限时优先给最强的信号", () => {
    const plan = planDay({
      asOf: "2026-03-02",
      positions: [],
      signals: [sig("LOW", 55), sig("HIGH", 95), sig("MID", 70)],
      book: book([]),
      cash: 250,
      equity: 1000,
    });
    expect(plan.buys.map((b) => b.symbol)).toEqual(["HIGH", "MID"]);
    expect(plan.passes.map((p) => p.symbol)).toEqual(["LOW"]);
  });

  it("一只持仓不会被两个新信号同时顶掉", () => {
    const b = book([lot("W"), lot("S")], 0);
    const plan = planDay({
      asOf: "2026-03-02",
      positions: [pos("W", 30), pos("S", 35)],
      signals: [sig("N1", 95), sig("N2", 90)],
      book: b,
      cash: 0,
      equity: 1000,
      rules: { slotPct: 0.125, rotateEdge: 20 },
    });
    expect(plan.sells.map((s) => s.symbol).sort()).toEqual(["S", "W"]);
    expect(plan.buys).toHaveLength(2);
  });
});
