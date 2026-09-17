import type { SignalCandle } from "@/lib/discord/signalTradeChart";

const WR_PERIOD = 14;
const RECOVERY_LOOKBACK = 3;
const OVERSOLD = -80;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** 输入须为 buyChartOf 校验后的未压缩、截至信号收盘的 K 线。规则权重未做收益标定。 */
export function positionFactorOf(bars: SignalCandle[] | undefined, price: number, atr: number | undefined, maxPoints = 15) {
  const last = bars?.at(-1);
  if (!bars || !last || !positive(atr) || !last.slice(6).every(positive)) {
    return { points: null, reason: "缺少 Vegas 或 ATR，无法判断位置" };
  }
  // 四个完整 WR14 读数：前三根观察是否超卖，当前根判断恢复。
  if (bars.length < WR_PERIOD + RECOVERY_LOOKBACK) {
    return { points: null, reason: "不足 17 根连续 K 线，无法判断 WR14 恢复" };
  }
  const wr: number[] = [];
  for (let end = bars.length - RECOVERY_LOOKBACK; end <= bars.length; end++) {
    const window = bars.slice(end - WR_PERIOD, end);
    const high = Math.max(...window.map(b => b[3]));
    const low = Math.min(...window.map(b => b[4]));
    if (high === low) return { points: null, reason: "WR14 窗口无价格波动，位置评分缺失" };
    wr.push(-100 * (high - window.at(-1)![5]) / (high - low));
  }
  const current = wr.at(-1)!, previous = wr.at(-2)!;
  // 同时要求真实收盘价上涨，避免旧极值滚出窗口造成 WR 上升就加分。
  const rising = current > previous && last[5] > bars.at(-2)![5];
  const recovered = rising && current >= OVERSOLD && wr.slice(0, -1).some(value => value < OVERSOLD);
  const recovery = recovered ? 7 : rising ? 3 : 0;
  const state = recovered ? "近3根超卖后回升" : rising ? "价格与 WR 同步回升" : "未确认同步回升";
  const wrReason = `WR14 ${previous.toFixed(1)} → ${current.toFixed(1)} · ${state}`;

  const channels = [[last[6]!, last[7]!], [last[8]!, last[9]!]];
  const support = channels.filter(channel => price >= Math.min(...channel));
  if (!support.length) return { points: 0, reason: `价格在两组通道下方 · ${wrReason}` };
  const distance = Math.min(...support.map(channel => Math.max(0, price - Math.max(...channel)))) / atr;
  const proximity = clamp(1 - distance / 4);
  // V4 只放大本项总权重，保持 V3 的 8:7 内部比例和恢复条件。
  const vegasMax = maxPoints * 8 / 15, wrMax = maxPoints * 7 / 15;
  const vegasPoints = vegasMax * proximity, wrPoints = maxPoints * recovery / 15 * proximity;
  return {
    points: vegasPoints + wrPoints,
    reason: `距下方最近 Vegas 通道 ${distance.toFixed(2)} ATR · ${wrReason} · Vegas ${vegasPoints.toFixed(1)}/${vegasMax.toFixed(1)} + WR ${wrPoints.toFixed(1)}/${wrMax.toFixed(1)}`,
  };
}
