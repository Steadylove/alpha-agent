import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryQualityOf, QUALITY_WEIGHTS, qualityPanel, tradeReviewOf } from "@/lib/signals/assessment";
import { assessedAlertView, tradeIdOf } from "@/lib/signals/journal";
import { buildAlertView, type AlertPayload } from "@/lib/discord/tvAlertCopy";
import { fundScoreOf } from "@/lib/scoring/fundScore";
import { signalCardSvg } from "@/lib/discord/signalCardImage";
import { signalBars, volumeFixture, SIGNAL_BAR_MS } from "./fixtures/signalVolume";

const fund = fundScoreOf({ epsYoy: .5, revYoy: .4, roe: .3, dist52w: -1, gmTtm: .6, debtEquity: 1 });
const bars = signalBars;
const buyTime=bars.at(-1)![1];
const buy: AlertPayload = { event: "buy", symbol: "TEST", tf: "240", kind: 1, price: 102, atr: 1.5, stopMult: 4,
  barTime: buyTime, strategyKey: "aa-4h-v1|4|6|3", entrySignalTime: buyTime, chart: { version: 1, stride: 1, bars }, volumeSnapshot:volumeFixture() };
const sell: AlertPayload = { ...buy, event: "sell", price: 120, entry: 100, entryTime: buyTime+1000, barTime: buyTime+6*SIGNAL_BAR_MS,
  initialRisk: 6, barsHeld: 20, highSinceEntry: 125, lowSinceEntry: 95, exitReason: "target", target: 118, pnl: 20, chart: undefined };

describe("买点观察分", () => {
  it("只使用买点截止的图和排名，完整资料按 100 分展示", () => {
    const q = entryQualityOf(buy, 80, fund);
    expect(q.complete).toBe(true);
    expect(q.available).toBe(100);
    expect(q.points).toBeGreaterThan(65);
    expect(q.dimensions.map((d) => d.max)).toEqual([20, 30, 25, 15, 10]);
    expect(Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const future = { ...buy, chart: { version: 1, stride: 1, bars: [...bars, [4000, 4100, 100, 103, 99, 102, 100, 99, 97, 96]] } };
    expect(entryQualityOf(future, 80, fund).available).toBe(75);
    expect(q.dimensions.map(d=>d.name)).toEqual(["CVD背离","强度","位置","风险","成交分布"]);
  });
  it("财务完全不参与新评分，缺少分钟快照不补零或放大到百分制", () => {
    const far = structuredClone(fund);
    far.dims.find((d) => d.id === "dist52w")!.points = 0;
    expect(entryQualityOf(buy, 80, far).points).toBe(entryQualityOf(buy, 80, fund).points);
    expect(entryQualityOf(buy,80).points).toBe(entryQualityOf(buy,80,fund).points);
    const partial = entryQualityOf({...buy,volumeSnapshot:undefined}, 80, fund);
    expect(partial.available).toBe(70);
    expect(partial.label).toBe("资料未齐");
    expect(qualityPanel(partial).note).toContain("非胜率");
    expect(entryQualityOf(buy, NaN, fund).available).toBe(70);
  });
  it("原生指标按新权重缩放，各项展示分数相加等于总分，缺项按新权重扣除", () => {
    const q = entryQualityOf(buy, 80);
    const dimension = (name: string) => q.dimensions.find(d => d.name === name)!;
    expect(dimension("CVD背离")).toMatchObject({ points: 13.3, max: 20 }); // 原生 20/30。
    expect(dimension("强度")).toMatchObject({ points: 24, max: 30 });
    expect(dimension("成交分布")).toMatchObject({ points: 10, max: 10 }); // 原生 15/15。
    expect(q.points).toBeCloseTo(q.dimensions.reduce((sum, d) => sum + (d.points ?? 0), 0), 8);
    expect(q.dimensions.every(d => d.points == null || d.points >= 0 && d.points <= d.max)).toBe(true);
    const noProfile = volumeFixture();
    noProfile.profile.volumes[0] += 200;
    const partial = entryQualityOf({ ...buy, volumeSnapshot: noProfile }, 80);
    expect(partial.available).toBe(90);
    expect(partial.points).toBeCloseTo(q.points - 10, 8);
    expect(partial.label).toBe("资料未齐");
  });
  it("不把通道下方当成支撑，独立分钟快照不依赖压缩图", () => {
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
  it("旧 V1 入场记录保持原始总分，新卡不展示已移除的维度或财务明细", async () => {
    const id=tradeIdOf(buy)!;
    const quality={version:"quality-v1",points:81,available:100,complete:true,label:"较强",
      dimensions:[{name:"趋势",max:30,points:25,reason:"旧趋势"},{name:"财务",max:15,points:15,reason:"旧财务"}]};
    const record={version:1,id,capturedAt:new Date().toISOString(),payload:buy,quality,fund,rps:80};
    mkdirSync(join(dir,"signal-entries"));
    const file=join(dir,"signal-entries",`${id}.json`);writeFileSync(file,JSON.stringify(record));
    const before=readFileSync(file,"utf8");
    const view=await assessedAlertView(buy,"4H",99);
    expect(view.quality).toBeUndefined();
    expect(view.assessment?.headline).toContain("81 / 100");
    expect(view.assessment?.heading).toContain("V1");
    expect(signalCardSvg(view)).not.toMatch(/旧趋势|旧财务|财务与位置概览|基本面/);
    expect(readFileSync(file,"utf8")).toBe(before);
  });
  it.each(["quality-v2", "quality-v3"] as const)("旧 %s 重放继续使用冻结的权重和分数，买卖卡均不以 V4 覆盖", async (version) => {
    const id = tradeIdOf(buy)!;
    const quality = { version, points: 81, available: 100, complete: true, label: "优秀", dimensions: [
      { name: "CVD背离", points: 24, max: 30, reason: "旧 CVD 分" },
      { name: "强度", points: 20, max: 25, reason: "旧强度分" },
      { name: "位置", points: 13, max: 15, reason: version === "quality-v2" ? "旧 Vegas 距离分" : "旧 Vegas 与 WR 分" },
      { name: "风险", points: 14, max: 15, reason: "旧止损分" },
      { name: "成交分布", points: 10, max: 15, reason: "旧成交分布" },
    ] };
    const record = { version: 1, id, capturedAt: new Date().toISOString(), payload: buy, quality, rps: 80 };
    mkdirSync(join(dir, "signal-entries"));
    const file = join(dir, "signal-entries", `${id}.json`);
    writeFileSync(file, JSON.stringify(record));
    const before = readFileSync(file, "utf8");
    const view = await assessedAlertView(buy, "4H", 99);
    expect(view.quality).toEqual(quality);
    const label = version === "quality-v2" ? "V2" : "V3";
    expect(view.assessment?.heading).toContain(label);
    expect(view.assessment?.note).toContain("与 V4 不直接比较");
    expect(signalCardSvg(view)).toContain(`买点质量 · ${label}`);
    expect(signalCardSvg(view)).not.toContain("买点质量 · V4");
    expect((await assessedAlertView(sell, "4H", 99)).assessment?.headline).toContain("入场 81/100");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
