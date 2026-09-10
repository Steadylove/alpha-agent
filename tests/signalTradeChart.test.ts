import { describe, expect, it } from "vitest";
import { signalCardSvg } from "@/lib/discord/signalCardImage";
import { buildAlertView } from "@/lib/discord/tvAlertCopy";
import { buyChartOf, sellChartOf, signalTradeChartLayout, signalTradeChartNote, signalTradeChartSvg, type SignalCandle } from "@/lib/discord/signalTradeChart";

const start = Date.parse("2026-09-08T13:30:00Z"), hour = 3_600_000;
function fixture() {
  // 相邻交易日有隔夜缺口，同价重复出现，买点只能靠时间定位。
  const bars: SignalCandle[] = [
    [start, start + 4 * hour, 100, 105, 99, 104, 98, 97, 92, 90],
    [start + 4 * hour, start + 6.5 * hour, 104, 106, 100, 102, 98, 97, 92, 90],
    [start + 24 * hour, start + 28 * hour, 100, 112, 99, 110, 99, 98, 93, 91],
  ];
  return { event: "sell", symbol: "CF", tf: "240", kind: 1, entry: 100, price: 110, pnl: 10,
    entryTime: bars[2][0], barTime: bars[2][1], chart: { version: 1, stride: 1, bars } };
}
function parse(p: ReturnType<typeof fixture>) {
  return sellChartOf(p.chart, p.entryTime, p.entry, p.barTime, p.price);
}

describe("买卖点交易图", () => {
  it("按实际开仓时间定位，允许隔夜和同根买入后出现卖点", () => {
    const p = fixture(), chart = parse(p)!;
    expect(chart).toBeDefined();
    expect(signalTradeChartLayout(chart).entryIndex).toBe(2);
    const view = buildAlertView(p, "4H");
    expect(view.chart).toEqual(chart);
    const svg = signalCardSvg(view);
    expect(svg).toContain("买入 $100.00");
    expect(svg).toContain("卖点 $110.00");
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  it("长持仓合并柱仍按时间范围定位，标注合并口径", () => {
    const p = fixture();
    p.chart.stride = 2;
    p.chart.bars[0] = [start, start + 6.5 * hour, 100, 106, 99, 102, 98, 97, 92, 90];
    p.chart.bars.splice(1, 1);
    p.entryTime = start + 4 * hour;
    const chart = parse(p)!;
    expect(signalTradeChartLayout(chart).entryIndex).toBe(0);
    expect(signalTradeChartNote(chart)).toContain("每根合并 2 根");
  });

  it("买入早于窗口时只画参考线，不捏造窗口内的买点", () => {
    const p = fixture(); p.entryTime = start - 24 * hour;
    const chart = parse(p)!;
    expect(signalTradeChartLayout(chart).entryIndex).toBe(-1);
    expect(signalTradeChartNote(chart)).toContain("买入早于图示区间");
    expect(signalCardSvg(buildAlertView(p, "4H"))).toContain("区间外买入");
  });

  it("Vegas 预热空值保留为间断通道", () => {
    const p = fixture(); p.chart.bars[1][6] = null;
    const chart = parse(p)!;
    const svg = signalTradeChartSvg(chart);
    expect(svg.match(/fill="#22D3EE"/g)).toHaveLength(2);
    expect(svg).not.toMatch(/NaN|Infinity|null/);
  });

  it.each([
    ["错误协议", (p: ReturnType<typeof fixture>) => { p.chart.version = 2; }],
    ["缺行情", (p: ReturnType<typeof fixture>) => { p.chart.bars = []; }],
    ["未来买入", (p: ReturnType<typeof fixture>) => { p.entryTime = p.barTime + 1; }],
    ["时间缺口内买入", (p: ReturnType<typeof fixture>) => { p.entryTime = start + 10 * hour; }],
    ["无效时间", (p: ReturnType<typeof fixture>) => { p.entryTime = Number.MAX_SAFE_INTEGER; }],
    ["过期行情", (p: ReturnType<typeof fixture>) => { p.barTime += hour; }],
    ["未来行情", (p: ReturnType<typeof fixture>) => { p.chart.bars[2][1] += hour; }],
    ["同价旧行情", (p: ReturnType<typeof fixture>) => { p.chart.bars[2][0] -= 30 * hour; }],
    ["价格不一致", (p: ReturnType<typeof fixture>) => { p.price = 109; }],
    ["错误 OHLC", (p: ReturnType<typeof fixture>) => { p.chart.bars[0][3] = 99; }],
    ["非数字 EMA", (p: ReturnType<typeof fixture>) => { p.chart.bars[0][6] = NaN; }],
    ["错误合并数", (p: ReturnType<typeof fixture>) => { p.chart.stride = 0; }],
    ["快照超长", (p: ReturnType<typeof fixture>) => { p.chart.bars = Array(121).fill(p.chart.bars[0]); }],
  ])("%s 时降级为原卖点卡片", (_, mutate) => {
    const p = fixture(); mutate(p);
    expect(parse(p)).toBeUndefined();
    const view = buildAlertView(p, "4H");
    expect(view.chart).toBeUndefined();
    expect(view.title).toBe("止盈");
  });

  it("旧买卖点告警没有快照仍兼容", () => {
    expect(buildAlertView({ event: "sell", symbol: "CF", tf: "240", kind: 1, price: 110 }, "4H").chart).toBeUndefined();
    expect(buildAlertView({ event: "buy", symbol: "CF", tf: "240", kind: 1, price: 110 }, "4H", 90).chart).toBeUndefined();
  });

  it("买点标在最新已收盘 K 线上，不使用尚不存在的开仓价或卖点", () => {
    const p = fixture();
    const view = buildAlertView({ ...p, event: "buy", entry: 9999, entryTime: p.barTime + hour }, "4H", 90);
    expect(view.chart).toMatchObject({ event: "buy", signalTime: p.barTime, signalPrice: 110 });
    expect(view.chart).not.toHaveProperty("entryPrice");
    const chart = view.chart!;
    expect(signalTradeChartNote(chart)).toContain("买点为收盘触发价");
    const svg = signalCardSvg(view);
    expect(svg).toContain("买点 $110.00");
    expect(svg).not.toMatch(/卖点|区间外买入|9999/);
    const { x, y } = signalTradeChartLayout(chart);
    expect(signalTradeChartSvg(chart)).toContain(`M${x(2).toFixed(2)},${y(110).toFixed(2)}`);
  });

  it.each(["future", "stale", "price"])("买点 %s 快照不能用于当前信号", (invalid) => {
    const p = fixture();
    if (invalid === "future") p.chart.bars[2][1] += hour;
    if (invalid === "stale") p.barTime += hour;
    if (invalid === "price") p.price = 109;
    expect(buyChartOf(p.chart, p.barTime, p.price)).toBeUndefined();
    expect(buildAlertView({ ...p, event: "buy" }, "4H", 90).chart).toBeUndefined();
  });
});
