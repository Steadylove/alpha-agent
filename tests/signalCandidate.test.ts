import { describe, expect, it } from "vitest";
import type { SignalCandle } from "@/lib/discord/signalTradeChart";
import { candidatePositionOf } from "@/lib/signals/positionCandidate";
import { candidateAssessmentOf, candidatePreviewView, CANDIDATE_WEIGHTS, sharesForRiskBudget } from "@/lib/signals/candidateAssessment";
import { buildSectorSnapshot, sectorFactorOf, strictSectorId } from "@/lib/signals/sectorFactor";
import { buildAlertView, type AlertPayload } from "@/lib/discord/tvAlertCopy";
import { signalCardSvg } from "@/lib/discord/signalCardImage";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";
import type { PanelBars } from "@/lib/backtest/panel";

function prices(tail: number[], distance = 0): SignalCandle[] {
  const closes = [...Array<number>(40 - tail.length).fill(100), ...tail], end = closes.at(-1)!;
  return closes.map((c, i) => [Date.UTC(2026, 0, i + 1), Date.UTC(2026, 0, i + 2), c, 110, 90, c,
    end - distance + (i - 39) * .01, end - distance - .1 + (i - 39) * .01,
    end - distance - 4 + (i - 39) * .005, end - distance - 5 + (i - 39) * .005]);
}
const position = (tail: number[], distance = 0) => candidatePositionOf(prices(tail, distance), tail.at(-1)!, 1);

describe("V5 位置状态", () => {
  it("相同结构下确认恢复优于回调中；超卖不是自动满分", () => {
    expect(position([91, 92, 95]).state).toBe("回调恢复");
    expect(position([91, 92, 95]).points).toBeGreaterThan(position([97, 96, 95]).points!);
    expect(position([93, 92, 91]).points).toBeLessThan(25);
    expect(position([91, 92, 95]).raw?.wr14).toBe(-75);
  });
  it("高位维持不额外扣分，远离通道封顶而不是归零", () => {
    expect(position([109, 109, 109, 109]).state).toBe("高位维持");
    expect(position([109, 109, 109, 109]).points).toBe(position([100, 100, 100, 100]).points);
    expect(position([91, 92, 95], 5).points).toBe(12);
    expect(position([91, 92, 95], 5).state).toBe("回升但偏远");
    expect(position([91, 92, 95], -6).points).toBeLessThanOrEqual(5);
  });
  it("极值滚出造成 WR 改善不假装价格恢复；38 根与平滑窗口严格校验", () => {
    const bars = prices([100, 100]); bars[bars.length - 15][3] = 120;
    const p = candidatePositionOf(bars, 100, 1);
    expect(p.raw?.priceRecovery).toBe(false);
    expect(p.raw?.recovered).toBe(false);
    expect(candidatePositionOf(bars.slice(-37), 100, 1).points).toBeNull();
    expect(candidatePositionOf(bars.slice(-38), 100, 1).points).not.toBeNull();
  });
});

const dates = Array.from({ length: 51 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
function panel(ticker: string, values: number[]): PanelBars {
  return { ticker, dates: [...dates], close: Float32Array.from(values), high: Float32Array.from(values), low: Float32Array.from(values), open: null, volume: null };
}
function fixture() {
  const members = Array.from({ length: 20 }, (_, i) => ({ symbol: `T${i}`, sector: "Technology" }));
  const panels = [panel("SPY", dates.map((_, i) => 100 + i)), ...SECTOR_UNIVERSE.map((s, k) => panel(s.symbol, dates.map((_, i) => 100 + i * (k + 2)))),
    ...members.map((m, k) => panel(m.symbol, dates.map((_, i) => k < 12 ? 100 + i : 200 - i)))];
  const provenance = { generatedAt: "2026-02-20T10:00:00Z", membershipAsOf: "2026-02-20", membershipSource: "test" };
  return { members, panels, provenance };
}
describe("V5 板块：截断行情与覆盖率", () => {
  it("20 日相对收益和 50 日广度只用指定日之前价格", () => {
    const f = fixture(), day = dates[49];
    const first = buildSectorSnapshot(f.panels, f.members, day, f.provenance);
    for (const p of f.panels) p.close[50] = 100000;
    expect(buildSectorSnapshot(f.panels, f.members, day, f.provenance)).toEqual(first);
    expect(first.sectors[0]).toMatchObject({ valid: 20, total: 20, breadth: .6 });
    expect(first.sectors[0].relative20).toBeCloseTo(198 / 158 - 149 / 129);
  });
  it("有效样本不足、ETF缺失和未知板块不能补分", () => {
    const f = fixture();
    expect(strictSectorId("Unknown")).toBeUndefined();
    f.panels = f.panels.filter(p => !["T1", "T2"].includes(p.ticker));
    expect(buildSectorSnapshot(f.panels, f.members, dates[49], f.provenance).sectors[0].points).toBeNull();
    const all = fixture(); all.panels = all.panels.filter(p => p.ticker !== "XLK");
    expect(buildSectorSnapshot(all.panels, all.members, dates[49], all.provenance).sectors.every(s => s.points == null)).toBe(true);
  });
  it("线上拒绝过期或事后快照，历史重算必须显式标识", () => {
    const f = fixture(), s = buildSectorSnapshot(f.panels, f.members, dates[49], f.provenance);
    const time = Date.parse("2026-02-20T16:00:00Z");
    expect(sectorFactorOf(s, "T1", dates[49], time).points).not.toBeNull();
    expect(sectorFactorOf(s, "T1", dates[48], time).points).toBeNull();
    const later = { ...s, generatedAt: "2026-03-01T00:00:00Z", membershipAsOf: "2026-03-01" };
    expect(sectorFactorOf(later, "T1", dates[49], time).points).toBeNull();
    expect(sectorFactorOf(later, "T1", dates[49], time, true).points).not.toBeNull();
    expect(sectorFactorOf(s, "UNKNOWN", dates[49], time).points).toBeNull();
    expect(sectorFactorOf({ ...s, asOf: "2026-02-20" }, "T1", "2026-02-20", time, true).points).toBeNull();
  });
});

describe("候选评分与风险分离", () => {
  it("止损宽度不影响V5总分，V4基线保留且五权重合计100", () => {
    const bars = prices([91, 92, 95]);
    const payload: AlertPayload = { event: "buy", symbol: "TEST", tf: "240", kind: 1, price: 95, atr: 1, stopMult: 4,
      barTime: bars.at(-1)![1], chart: { version: 1, stride: 1, bars } };
    const candidate = candidateAssessmentOf(payload, 80);
    const wider = candidateAssessmentOf({ ...payload, stopMult: 10 }, 80);
    expect(candidate.quality).toEqual(wider.quality);
    expect(candidate.baseline.points).not.toBe(wider.baseline.points);
    expect(candidate.quality.dimensions.map(d => d.max)).toEqual([30, 25, 20, 15, 10]);
    expect(candidate.quality.available).toBe(55);
    expect(candidate.quality.label).toBe("资料未齐");
    expect(Object.values(CANDIDATE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const svg = signalCardSvg(candidatePreviewView(buildAlertView(payload, "4H", 80), candidate));
    expect(svg).toContain("V5试算"); expect(svg).toContain("板块共振"); expect(svg).not.toContain("止损评分");
    expect(sharesForRiskBudget(100, 95, 90)).toBe(20);
    expect(sharesForRiskBudget(100, 95, 95)).toBeNull();
  });
  it("信号后的K线不能进入候选位置特征", () => {
    const bars = prices([91, 92, 95]);
    const p: AlertPayload = { event: "buy", symbol: "TEST", tf: "240", kind: 1, price: 95, atr: 1,
      barTime: bars.at(-2)![1], chart: { version: 1, stride: 1, bars } };
    expect(candidateAssessmentOf(p).position.points).toBeNull();
  });
});
