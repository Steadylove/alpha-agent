import { aggregateTo2H, barTimeISO, type IntradayBar } from "@/lib/data-sources/yahooIntraday";
import type { PanelBars } from "./panel";

/** 行情清单的 1H 末棒映射到它所属的 2H 棒，短交易日也成立。 */
export function twoHourAsOf(hourlyAsOf: string | undefined): string | undefined {
  if (!hourlyAsOf) return undefined;
  const timestamp = Date.parse(hourlyAsOf.endsWith("Z") ? hourlyAsOf : `${hourlyAsOf}Z`) / 1000;
  if (!Number.isFinite(timestamp)) throw new Error("1H 行情清单时间无效");
  const bar = aggregateTo2H([{ timestamp, open: 1, high: 1, low: 1, close: 1, volume: 0 }]).at(-1);
  if (!bar) throw new Error("1H 行情清单末棒不在常规交易时段");
  return barTimeISO(bar.timestamp);
}

/** 1H 必须从 9:30 起分桶，包含 15:30 的末半小时。旧 2H 无法反拆。 */
export function twoHourBarsFromHourly(panel: PanelBars): IntradayBar[] {
  if (!panel.open || !panel.volume) throw new Error(`${panel.ticker} 的 1H 缺少开盘价或成交量，不能重建 2H`);
  const raw: IntradayBar[] = [];
  let last = -Infinity;
  for (let i = 0; i < panel.dates.length; i += 1) {
    const date = panel.dates[i];
    const stamp = Date.parse(`${date}:00Z`) / 1000;
    // 美股 EST/EDT 都是整小时偏移，因此 UTC 分钟也必须为 :30。
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:30$/.test(date) || !Number.isFinite(stamp) || stamp <= last) {
      throw new Error(`${panel.ticker} 的 1H 时间轴无效：${date}，需要补齐标准 1H 数据`);
    }
    last = stamp;
    raw.push({ timestamp: stamp, open: panel.open[i], high: panel.high[i], low: panel.low[i], close: panel.close[i], volume: panel.volume[i] });
  }
  const bars = aggregateTo2H(raw);
  if (!bars.length) throw new Error(`${panel.ticker} 的 1H 没有常规时段行情`);
  return bars;
}

export function twoHourPanelFromHourly(panel: PanelBars): PanelBars {
  const bars = twoHourBarsFromHourly(panel);
  return {
    ticker: panel.ticker, dates: bars.map((b) => barTimeISO(b.timestamp)),
    open: Float32Array.from(bars.map((b) => b.open)), high: Float32Array.from(bars.map((b) => b.high)),
    low: Float32Array.from(bars.map((b) => b.low)), close: Float32Array.from(bars.map((b) => b.close)),
    volume: Float32Array.from(bars.map((b) => b.volume)),
  };
}
