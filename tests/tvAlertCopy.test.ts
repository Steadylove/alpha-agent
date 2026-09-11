import { signalCardSvg } from "@/lib/discord/signalCardImage";
import { buildAlertView, buyPassesGate, renderBuy, renderSell, rpsMinOf } from "@/lib/discord/tvAlertCopy";
import { fundScoreOf } from "@/lib/scoring/fundScore";
import { describe, expect, it } from "vitest";

describe("tv alert copy", () => {
  it("门槛与引擎一致", () => {
    expect(rpsMinOf("4h")).toBe(30);
    expect(rpsMinOf("1h")).toBe(30);
    expect(rpsMinOf("1d")).toBe(40);
    expect(rpsMinOf("2h")).toBe(0);
  });

  it("查不到、未排名、不过门槛都不推", () => {
    expect(buyPassesGate(null, 30)).toBe(false);
    expect(buyPassesGate(0, 30)).toBe(false);
    expect(buyPassesGate(29.9, 30)).toBe(false);
    expect(buyPassesGate(30, 30)).toBe(true);
    expect(buyPassesGate(1, 0)).toBe(true);
    expect(buyPassesGate(0, 0)).toBe(false);
  });

  it("买点写该股相对大池分位，不写门槛、一买二买和 RPS", () => {
    const msg = renderBuy({ event: "buy", symbol: "NVDA", tf: "240", kind: 1, price: 100 }, "4H", 79);
    const text = JSON.stringify(msg);
    expect(msg.content).toBe("🟢 **TREND-ADAPTIVE 买点 · NVDA**");
    expect(text).toContain("强于 79%");
    expect(text).not.toContain("强于 30%");
    expect(text).not.toMatch(/一买|二买|RPS|未达标/);
  });

  it("信号图写该股分位，不写门槛和 RPS", () => {
    const svg = signalCardSvg(
      buildAlertView({ event: "buy", symbol: "NVDA", tf: "240", kind: 1, price: 178.4, atr: 4.2, stopMult: 4 }, "4H", 79),
    );
    expect(svg).toContain("TREND-ADAPTIVE");
    expect(svg).toContain("NVDA");
    expect(svg).toContain("买点");
    expect(svg).toContain("强于 79%");
    expect(svg).toContain("$178.40");
    expect(svg).toContain("近期波动");
    expect(svg).toContain(">较大<");
    expect(svg).not.toContain("ATR");
    expect(svg).not.toContain(">4.20<");
    expect(svg).not.toContain("$4.20");
    expect(svg).toContain("2.35%");
    expect(svg).not.toContain("强于 30%");
    expect(svg).not.toMatch(/一买|二买|RPS|未达标/);
  });

  it("卖点标题也不带一买二买", () => {
    const msg = renderSell(
      { event: "sell", symbol: "ADI", tf: "240", kind: 2, price: 90, entry: 100, pnl: -10, exitReason: "initial_stop", stop: 92 },
      "4H",
    );
    const text = JSON.stringify(msg);
    expect(msg.content).toBe("🛑 **TREND-ADAPTIVE 初始止损 · ADI**");
    expect(text).not.toMatch(/一买|二买/);
  });

  it("卖点同时写分位、波动描述和盈亏", () => {
    const svg = signalCardSvg(
      buildAlertView(
        { event: "sell", symbol: "ADI", tf: "240", kind: 2, price: 90, entry: 100, pnl: -10, atr: 2.7, exitReason: "initial_stop", stop: 92 },
        "4H",
        64,
      ),
    );
    expect(svg).toContain("止损");
    expect(svg).toContain("强于 64%");
    expect(svg).toContain("相对大池");
    expect(svg).toContain("-10.00%");
    expect(svg).toContain("近期波动");
    expect(svg).toContain(">较大<");
    expect(svg).toContain("单根平均波幅约 3.00%");
    expect(svg).not.toContain("ATR");
    expect(svg).not.toContain(">2.70<");
    expect(svg).not.toContain("$2.70");
    expect(svg).toContain("3.00%");
    expect(svg).not.toMatch(/一买|二买|RPS|未达标/);
  });

  it("买卖点卡写入基本面梯队，不另出图", () => {
    const fund = fundScoreOf({
      epsYoy: 0.41, revYoy: 0.3, roe: 0.2, dist52w: -9, gmTtm: 0.45, debtEquity: 1.2,
    });
    const svg = signalCardSvg(
      buildAlertView({ event: "buy", symbol: "NVDA", tf: "240", kind: 1, price: 178.4, atr: 4.2, stopMult: 4 }, "4H", 79, fund),
    );
    expect(svg).toContain("基本面");
    expect(svg).toContain("S+ 100");
    expect(svg).toContain("盈利增速");
    expect(svg).toContain("买点");
  });
});
