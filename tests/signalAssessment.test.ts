import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryQualityOf, qualityPanel, tradeReviewOf } from "@/lib/signals/assessment";
import { assessedAlertView, tradeIdOf } from "@/lib/signals/journal";
import { buildAlertView, type AlertPayload } from "@/lib/discord/tvAlertCopy";
import { fundScoreOf } from "@/lib/scoring/fundScore";
import { signalCardSvg } from "@/lib/discord/signalCardImage";

const fund = fundScoreOf({ epsYoy: .5, revYoy: .4, roe: .3, dist52w: -1, gmTtm: .6, debtEquity: 1 });
const bars = Array.from({ length: 30 }, (_, i) => [1000 + i * 100, 1100 + i * 100, 100, 103, 99, 102, 97 + i / 10, 96.8 + i / 10, 94 + i / 20, 93.8 + i / 20]);
const buy: AlertPayload = { event: "buy", symbol: "TEST", tf: "240", kind: 1, price: 102, atr: 1.5, stopMult: 4,
  barTime: 4000, strategyKey: "aa-4h-v1|4|6|3", entrySignalTime: 4000, chart: { version: 1, stride: 1, bars } };
const sell: AlertPayload = { ...buy, event: "sell", price: 120, entry: 100, entryTime: 5000, barTime: 10000,
  initialRisk: 6, barsHeld: 20, highSinceEntry: 125, lowSinceEntry: 95, exitReason: "target", target: 118, pnl: 20, chart: undefined };

describe("买点观察分", () => {
  it("只使用买点截止的图和排名，完整资料按 100 分展示", () => {
    const q = entryQualityOf(buy, 80, fund);
    expect(q.complete).toBe(true);
    expect(q.available).toBe(100);
    expect(q.points).toBeGreaterThan(65);
    expect(q.dimensions.map((d) => d.max)).toEqual([30, 25, 15, 15, 15]);
    const future = { ...buy, chart: { version: 1, stride: 1, bars: [...bars, [4000, 4100, 100, 103, 99, 102, 100, 99, 97, 96]] } };
    expect(entryQualityOf(future, 80, fund).available).toBe(55);
  });
  it("财务不重复计接近新高，缺项不补零或放大到百分制", () => {
    const far = structuredClone(fund);
    far.dims.find((d) => d.id === "dist52w")!.points = 0;
    expect(entryQualityOf(buy, 80, far).points).toBe(entryQualityOf(buy, 80, fund).points);
    const partial = entryQualityOf(buy, undefined, undefined);
    expect(partial.available).toBe(60);
    expect(partial.label).toBe("资料未齐");
    expect(qualityPanel(partial).note).toContain("非胜率");
    expect(entryQualityOf(buy, NaN, fund).available).toBe(75);
  });
  it("不把通道下方当成支撑，不使用压缩快照计算 10 根斜率", () => {
    const lowerBars = bars.map((b) => [...b.slice(0, 6), 110, 109, 105, 104]);
    const q = entryQualityOf({ ...buy, chart: { version: 1, stride: 1, bars: lowerBars } }, 80, fund);
    expect(q.dimensions.find((d) => d.name === "位置")?.points).toBe(0);
    expect(entryQualityOf({ ...buy, chart: { version: 1, stride: 2, bars } }, 80, fund).complete).toBe(false);
  });
});

describe("卖出复盘", () => {
  it("R、浮盈浮亏和回吐取全持仓记录，图表有无不影响统计", () => {
    const panel = tradeReviewOf(sell);
    expect(panel.lines.join(" ")).toContain("+3.33 R");
    expect(panel.lines.join(" ")).toContain("最大浮盈 +25.00%");
    expect(panel.lines.join(" ")).toContain("最大浮亏 -5.00%");
    expect(panel.lines.join(" ")).toContain("回吐 5.00 个百分点");
    expect(panel.lines[2]).toContain("达到预设目标");
    expect(buildAlertView(sell, "4H").title).toBe("目标止盈");
  });
  it("修正截图中的价差和盈亏冲突，退出条件矛盾时不写成功评价", () => {
    const bad: AlertPayload = { ...sell, price: 72.4, entry: 68.56, pnl: -3.2, stop: 70.8, exitReason: "initial_stop" };
    const view = buildAlertView(bad, "2H");
    expect(view.pnl).toBeCloseTo(5.60093, 4);
    expect(view.footer).toBeUndefined();
    expect(view.assessment?.lines.join(" ")).toContain("数据口径异常");
    expect(signalCardSvg(view)).not.toContain("-3.20%");
  });
  it("亏损不冒充目标止盈；旧告警及非法极值不编造复盘指标", () => {
    expect(buildAlertView({ ...sell, exitReason: "trailing_stop", stop: 121 }, "4H").title).toBe("移动止盈");
    const missing = tradeReviewOf({ ...sell, initialRisk: 0, highSinceEntry: 110, barsHeld: -1, exitReason: undefined });
    expect(missing.lines.join(" ")).toContain("无法计算");
    expect(missing.lines.join(" ")).toContain("风险收益 未记录");
    expect(missing.lines[2]).toContain("未记录退出原因");
  });
});

describe("不可变入场快照", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "signal-journal-")); vi.stubEnv("SIGNAL_JOURNAL_DIR", dir); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  it("重复买点、并发写入及卖出使用同一份最初评分", async () => {
    const original = await assessedAlertView(buy, "4H", 80, fund);
    const duplicate = await assessedAlertView(buy, "4H", 20);
    expect(duplicate.quality).toEqual(original.quality);
    expect(duplicate.rps).toBe(original.rps);
    const sold = await assessedAlertView(sell, "4H", 99);
    expect(sold.assessment?.headline).toContain(`入场 ${original.quality!.points}/100`);
    const concurrent = await Promise.all([assessedAlertView(buy, "4H", 10), assessedAlertView(buy, "4H", 90)]);
    expect(concurrent[0].quality).toEqual(concurrent[1].quality);
    expect(readdirSync(join(dir, "signal-entries"))).toHaveLength(1);
  });
  it("2H、参数版本、另一笔同价交易不串单；旧版不猜测匹配", async () => {
    await assessedAlertView(buy, "4H", 80, fund);
    for (const changed of [{ tf: "120" }, { strategyKey: "new-rules" }, { entrySignalTime: 4100 }]) {
      expect(tradeIdOf({ ...sell, ...changed })).not.toBe(tradeIdOf(buy));
      expect((await assessedAlertView({ ...sell, ...changed }, "4H", 80, fund)).assessment?.headline).toContain("入场评分未记录");
    }
    expect(tradeIdOf({ ...buy, strategyKey: undefined })).toBeNull();
    expect((await assessedAlertView({ ...sell, strategyKey: undefined }, "4H")).assessment?.note).toContain("旧版告警");
  });
  it("持久化服务不可用时保留信号卡，明确说明未保存，不假装有入场记录", async () => {
    vi.stubEnv("SIGNAL_JOURNAL_DIR", "");
    vi.stubEnv("MARKET_DATA_BASE_URL", "http://desk.example");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const view = await assessedAlertView(buy, "4H", 80, fund);
    expect(view.symbol).toBe("TEST");
    expect(view.assessment?.note).toContain("保存失败");
    const sold = await assessedAlertView(sell, "4H", 80, fund);
    expect(sold.assessment?.headline).toContain("入场评分未记录");
    expect(sold.assessment?.note).toContain("存储不可用");
  });
});
