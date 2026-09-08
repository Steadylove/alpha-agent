import { signalCardSvg } from "@/lib/discord/signalCardImage";
import { buildAlertView, buyPassesGate, renderBuy, renderSell, rpsMinOf } from "@/lib/discord/tvAlertCopy";
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
    expect(msg.content).toBe("🟢 **TREND-ADAPTIVE 买点 · NVDA** · 4H");
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
    expect(svg).not.toContain("强于 30%");
    expect(svg).not.toMatch(/一买|二买|RPS|未达标/);
  });

  it("卖点标题也不带一买二买", () => {
    const msg = renderSell(
      { event: "sell", symbol: "ADI", tf: "240", kind: 2, price: 90, entry: 100, pnl: -10 },
      "4H",
    );
    const text = JSON.stringify(msg);
    expect(msg.content).toBe("🛑 **TREND-ADAPTIVE 止损 · ADI** · 4H");
    expect(text).not.toMatch(/一买|二买/);
  });
});
