import { describe, expect, it } from "vitest";
import type { AlertPayload } from "@/lib/discord/tvAlertCopy";
import type { SignalCandle } from "@/lib/discord/signalTradeChart";
import { entryQualityOf } from "@/lib/signals/assessment";

function payload(tail: number[], distance = 0): AlertPayload {
  const prices = [...Array<number>(20 - tail.length).fill(100), ...tail];
  const price = prices.at(-1)!, channel = price - distance;
  const start = Date.UTC(2026, 0, 1), duration = 4 * 3600000;
  const bars: SignalCandle[] = prices.map((close, i) => [start + i * duration, start + (i + 1) * duration,
    close, 110, 90, close, channel, channel - 1, channel - 4, channel - 5]);
  return { event: "buy", symbol: "TEST", tf: "240", kind: 1, price, atr: 1, stopMult: 4,
    barTime: bars.at(-1)![1], chart: { version: 1, stride: 1, bars } };
}
const chartOf = (p: AlertPayload) => p.chart as { version: 1; stride: number; bars: SignalCandle[] };
const position = (p: AlertPayload) => entryQualityOf(p, 80).dimensions.find(d => d.name === "位置")!;

describe("位置评分 V4：Vegas 与 WR 的规则保持，权重升至 25", () => {
  it("相同均线距离下，区分继续下跌、超卖内反弹和收复超卖区", () => {
    const falling = position(payload([97, 96, 95]));
    const stillOversold = position(payload([91, 92, 93]));
    const recovered = position(payload([91, 92, 95]));
    expect(falling.points).toBe(13.3);
    expect(stillOversold.points).toBe(18.3);
    expect(recovered.points).toBe(25);
    expect(recovered.reason).toContain("WR14 -90.0 → -75.0");
    expect(recovered.reason).toContain("近3根超卖后回升");
  });

  it("WR 反弹不能抵消远离均线的扣分，通道下方不获得恢复分", () => {
    expect(position(payload([91, 92, 95], 2)).points).toBe(12.5);
    expect(position(payload([91, 92, 95], 4)).points).toBe(0);
    const below = payload([91, 92, 95]);
    chartOf(below).bars.at(-1)!.splice(6, 4, 101, 100, 99, 98);
    expect(position(below).points).toBe(0);
  });

  it("高位继续上涨保留一般恢复分，过期超卖不算近期恢复", () => {
    expect(position(payload([107, 108, 109])).points).toBe(18.3);
    expect(position(payload([91, 95, 96, 97, 98])).points).toBe(18.3);
  });

  it("旧高点滚出窗口造成 WR 上升、但价格未上涨时不加恢复分", () => {
    const p = payload([100, 100]);
    chartOf(p).bars[5][3] = 120;
    const score = position(p);
    expect(score.reason).toContain("WR14 -66.7 → -50.0");
    expect(score.points).toBe(13.3);
    expect(score.reason).toContain("未确认同步回升");
  });

  it("收复 -80 的边界有效，WR 或收盘价没有继续上涨则不加恢复分", () => {
    expect(position(payload([91, 92, 94])).points).toBe(25);
    expect(position(payload([91, 95, 95])).points).toBe(13.3);
    expect(position(payload([91, 96, 95])).points).toBe(13.3);
  });

  it("至少需要 17 根原周期 K 线，压缩或不足时整项缺失，不放大剩余分数", () => {
    const p = payload([91, 92, 95]);
    chartOf(p).bars = chartOf(p).bars.slice(-17);
    expect(position(p).points).toBe(25);
    chartOf(p).bars = chartOf(p).bars.slice(-16);
    const q = entryQualityOf(p, 80);
    expect(position(p).points).toBeNull();
    expect(q.available).toBe(45); // 无分钟快照：只剩强度 30 与风险 15。
    expect(q.complete).toBe(false);
    const compressed = payload([91, 92, 95]);
    chartOf(compressed).stride = 2;
    expect(position(compressed).points).toBeNull();
  });

  it("零振幅、缺失均线或 ATR 时不伪造 WR 或满分", () => {
    const flat = payload([100]);
    chartOf(flat).bars.forEach(bar => { bar[2] = bar[3] = bar[4] = bar[5] = 100; });
    expect(position(flat).points).toBeNull();
    expect(position(flat).reason).toContain("无价格波动");
    const missingEma = payload([91, 92, 95]);
    chartOf(missingEma).bars.at(-1)![6] = null;
    expect(position(missingEma).points).toBeNull();
    expect(position({ ...payload([91, 92, 95]), atr: 0 }).points).toBeNull();
  });

  it("拒绝信号之后的数据，不修改传入行情，只改变观察评分", () => {
    const p = payload([91, 92, 95]), original = structuredClone(p);
    const q = entryQualityOf(p, 80);
    expect(q.version).toBe("quality-v4");
    expect(q.dimensions.map(d => d.max)).toEqual([20, 30, 25, 15, 10]);
    expect(p).toEqual(original);
    const last = chartOf(p).bars.at(-1)!;
    chartOf(p).bars.push([last[1], last[1] + 4 * 3600000, ...last.slice(2)] as SignalCandle);
    expect(position(p).points).toBeNull();
  });
});
