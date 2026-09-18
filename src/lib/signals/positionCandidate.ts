import type { SignalCandle } from "@/lib/discord/signalTradeChart";

export type PositionFeatures = {
  wr14: number; wr34: number; wr34Smooth: number; wrSlope3: number;
  positionSpread: number; recovered: boolean; priceRecovery: boolean;
  distanceAtr: number; fastSlopeAtr: number; slowSlopeAtr: number;
  bullishStructure: boolean; structureBroken: boolean;
};
export type CandidatePosition = { points: number | null; state: string; reason: string; raw?: PositionFeatures };
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** V5 研究候选：固定规则先留痕；不修改 V4，也不把规则分当成胜率。 */
export function candidatePositionOf(bars: SignalCandle[] | undefined, price: number, atr: number | undefined): CandidatePosition {
  const missing = (reason: string): CandidatePosition => ({ points: null, state: "资料未齐", reason });
  if (!bars || bars.length < 38) return missing("至少需要 38 根未压缩 K 线计算 WR34 的 5 根平滑值");
  if (!positive(atr) || !positive(price) || !bars.slice(-4).every(b => b.slice(6).every(positive))) return missing("缺少 Vegas 或 ATR");
  const wr = (period: number, lag: number) => {
    const sample = bars.slice(bars.length - lag - period, bars.length - lag);
    const hi = Math.max(...sample.map(b => b[3])), lo = Math.min(...sample.map(b => b[4]));
    return hi > lo ? -100 * (hi - sample.at(-1)![5]) / (hi - lo) : NaN;
  };
  const short = [3, 2, 1, 0].map(lag => wr(14, lag));
  const medium = [4, 3, 2, 1, 0].map(lag => wr(34, lag));
  if (![...short, ...medium].every(Number.isFinite)) return missing("WR 窗口无价格波动");
  const last = bars.at(-1)!, old = bars.at(-4)!;
  const fast = avg([last[6]!, last[7]!]), slow = avg([last[8]!, last[9]!]);
  const fastSlopeAtr = (fast - avg([old[6]!, old[7]!])) / atr;
  const slowSlopeAtr = (slow - avg([old[8]!, old[9]!])) / atr;
  const bullishStructure = Math.min(last[6]!, last[7]!) > Math.max(last[8]!, last[9]!) && fastSlopeAtr > 0 && slowSlopeAtr >= 0;
  const structureBroken = price < Math.min(last[8]!, last[9]!);
  // 固定使用快通道中线；不随价格跌破而切换到更远的通道来美化距离。
  const distanceAtr = (price - fast) / atr;
  const priceRecovery = price > bars.at(-2)![5];
  const rising = short[3] > short[2] && priceRecovery;
  const recovered = rising && short[3] >= -80 && short.slice(0, -1).some(v => v < -80);
  const holdingHigh = short.every(v => v >= -20);
  const raw: PositionFeatures = { wr14: short[3], wr34: medium[4], wr34Smooth: avg(medium),
    wrSlope3: short[3] - short[0], positionSpread: medium[4] - short[3], recovered, priceRecovery,
    distanceAtr, fastSlopeAtr, slowSlopeAtr, bullishStructure, structureBroken };
  // 结构、距离、恢复分别计分：远离通道仅封顶，不把整项乘成零。
  const structure = bullishStructure ? 8 : structureBroken ? 0 : 4;
  const distance = Math.abs(distanceAtr);
  const location = distance <= 1 ? 8 : distance <= 2 ? 6 : distance <= 4 ? 3 : 1;
  const recovery = recovered ? 9 : rising ? 5 : 2; // 高位和回调中同为中性，无“超买扣分”。
  let points = structure + location + recovery;
  let state = recovered ? "回调恢复" : rising ? "同步回升" : holdingHigh ? "高位维持" : "回调观察";
  if (!bullishStructure) { points = Math.min(points, 15); state = "结构待确认"; }
  if (distance > 4) { points = Math.min(points, 12); state = rising ? "回升但偏远" : "偏离较大"; }
  if (structureBroken) { points = Math.min(points, 5); state = "慢通道失守"; }
  return { points, state, raw, reason: `${state} · 快通道偏离 ${distanceAtr.toFixed(2)} ATR · WR14 ${short[3].toFixed(1)} / WR34 ${medium[4].toFixed(1)} · 近3根恢复 ${raw.wrSlope3.toFixed(1)}` };
}
