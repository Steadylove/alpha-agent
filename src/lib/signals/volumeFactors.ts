/** 1 分钟量价估算；不是交易所逐笔主动买卖标记或实时盘口深度。 */
export const VOLUME_WINDOW = 20;
export const PROFILE_BINS = 32;
export type VolumeBar = [number, number, number, number, number, number, number, number, number, number, number];
export type VolumeSnapshot = {
  version: 1;
  method: "ltf-direction-v1";
  timeframe: "1";
  // [start, end, O, H, L, C, parentVolume, delta, coveredVolume, firstIntrabar, lastIntrabarClose]
  bars: VolumeBar[];
  profile: { method: "ltf-hlc3-v1"; low: number; high: number; volumes: number[]; samples: number };
};
export type VolumeFactor = { points: number | null; label: string; reason: string };
export type VolumeFactors = {
  cvd: VolumeFactor & { deltaRatio?: number; divergence?: "bullish" | "bearish" | "none" };
  profile: VolumeFactor & { poc?: number; val?: number; vah?: number; lowVolume?: boolean; valueAreaCoverage?: number;
    lowVolumeZones?: { low: number; high: number }[] };
};
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => num(v) && v > 0;
const stamp = (v: unknown): v is number => positive(v) && Number.isSafeInteger(v) && v <= 8.64e15;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const rounded = (v: number) => Math.round(v * 10) / 10;
const missing = (reason: string): VolumeFactors => ({
  cvd: { points: null, label: "未采集", reason: `CVD 背离：${reason}` },
  profile: { points: null, label: "未采集", reason: `成交分布：${reason}` },
});

function validatedBars(raw: unknown, signalTime: unknown, price: number): VolumeSnapshot | undefined {
  if (!raw || typeof raw !== "object" || !stamp(signalTime) || !positive(price)) return;
  const s = raw as VolumeSnapshot;
  if (s.version !== 1 || s.method !== "ltf-direction-v1" || s.timeframe !== "1" ||
      !Array.isArray(s.bars) || s.bars.length !== VOLUME_WINDOW) return;
  let lastEnd = 0;
  for (const b of s.bars) {
    if (!Array.isArray(b) || b.length !== 11 || !b.every(num)) return;
    const [start, end, o, h, l, c, volume, delta, covered, first, last] = b;
    if (![start, end, first, last].every(stamp) || start < lastEnd || end <= start || end > signalTime ||
        first < start || last > end || last <= first || last - first < 60_000 ||
        ![o,h,l,c,volume,covered].every(positive) || h < Math.max(o,c,l) || l > Math.min(o,c,h) ||
        Math.abs(delta) > covered + Math.max(.01, covered * 1e-6) ||
        covered / volume < .98 || covered / volume > 1.02) return;
    lastEnd = end;
  }
  const end = s.bars.at(-1)!;
  if (lastEnd !== signalTime || Math.abs(end[5]-price) > Math.max(.0002,price*1e-6)) return;
  return s;
}

/** 从 POC 向邻接较大成交量的一侧扩展至 70%；并列先扩展较低价格。 */
export function profileValueArea(volumes: readonly number[], fraction = .7) {
  if (!volumes.length || !volumes.every((v) => num(v) && v >= 0) || !(fraction > 0 && fraction <= 1)) return;
  const total = sum([...volumes]);
  if (!positive(total)) return;
  const poc = volumes.indexOf(Math.max(...volumes));
  let lo = poc, hi = poc, volume = volumes[poc];
  while (volume < total * fraction && (lo > 0 || hi < volumes.length-1)) {
    const left = lo > 0 ? volumes[lo-1] : -1;
    const right = hi < volumes.length-1 ? volumes[hi+1] : -1;
    if (left >= right) { lo--; volume += volumes[lo]; }
    else { hi++; volume += volumes[hi]; }
  }
  return { poc, lo, hi, total, coverage: volume/total };
}

export function volumeFactorsOf(raw: unknown, signalTime: unknown, price: number): VolumeFactors {
  const s = validatedBars(raw, signalTime, price);
  if (!s) return missing("缺少近 20 根 K 线的有效分钟量价快照；不补估分数");
  const bars = s.bars;
  let cumulative = 0;
  const cvd = bars.map((b) => cumulative += b[7]);
  const extreme = (from: number, to: number, field: 3 | 4, min: boolean) => {
    let index = from;
    for (let i = from+1; i < to; i++) if (min ? bars[i][field] < bars[index][field] : bars[i][field] > bars[index][field]) index = i;
    return index;
  };
  const low1 = extreme(0,10,4,true), low2 = extreme(10,20,4,true);
  const high1 = extreme(0,10,3,false), high2 = extreme(10,20,3,false);
  const total = sum(bars.map((b) => b[8]));
  if (!positive(total)) return missing("成交量总和无效；不补估分数");
  const priceTolerance = price * .0001, deltaTolerance = total * .01;
  const bullish = bars[low2][4] < bars[low1][4]-priceTolerance && cvd[low2] > cvd[low1]+deltaTolerance;
  const bearish = bars[high2][3] > bars[high1][3]+priceTolerance && cvd[high2] < cvd[high1]-deltaTolerance;
  // 两种背离同时成立时采取保守口径；固定规则，不使用之后的 pivot 确认。
  const divergence = bearish ? "bearish" : bullish ? "bullish" : "none";
  const recent = bars.slice(-5), preceding = bars.slice(-10,-5);
  const ratio = sum(recent.map((b) => b[7])) / sum(recent.map((b) => b[8]));
  const previousRatio = sum(preceding.map((b) => b[7])) / sum(preceding.map((b) => b[8]));
  const rawPoints = (divergence === "bullish" ? 12 : divergence === "bearish" ? 0 : 6) +
    10*clamp((ratio+.2)/.4) + 8*clamp((ratio-previousRatio+.2)/.4);
  const label = divergence === "bullish" ? "底背离" : divergence === "bearish" ? "顶背离" : "无明显背离";
  const result: VolumeFactors = {
    cvd: { points: rounded(divergence === "bearish" ? Math.min(6,rawPoints) : rawPoints), label, divergence, deltaRatio: ratio,
      reason: `CVD ${label}（估算）；近 5 根净量占比 ${ratio >= 0 ? "+" : ""}${(ratio*100).toFixed(1)}%` },
    profile: { points: null, label: "未采集", reason: "成交分布缺失或与量价快照不一致" },
  };
  const p = s.profile;
  if (!p || p.method !== "ltf-hlc3-v1" || !positive(p.low) || !positive(p.high) || p.high <= p.low ||
      !Array.isArray(p.volumes) || p.volumes.length !== PROFILE_BINS || !Number.isSafeInteger(p.samples) ||
      p.samples < VOLUME_WINDOW || p.samples > 100_000) return result;
  const area = profileValueArea(p.volumes);
  const low = Math.min(...bars.map((b) => b[4])), high = Math.max(...bars.map((b) => b[3]));
  // 分布边界使用父级窗口 high/low；分钟 HLC3 决定成交量归桶位置。
  if (!area || Math.abs(area.total-total) > Math.max(.1,total*1e-5) ||
      Math.abs(p.low-low) > .0002 || Math.abs(p.high-high) > .0002 || price < p.low || price > p.high) return result;
  const step = (p.high-p.low)/PROFILE_BINS;
  const poc = p.low+(area.poc+.5)*step, val = p.low+area.lo*step, vah = p.low+(area.hi+1)*step;
  const index = Math.max(0,Math.min(PROFILE_BINS-1,Math.floor((price-p.low)/step)));
  const lowVolume = p.volumes[index] < area.total/PROFILE_BINS*.5;
  const lowVolumeZones: { low: number; high: number }[] = [];
  for (let i = 0; i < PROFILE_BINS; i++) {
    if (p.volumes[i] >= area.total/PROFILE_BINS*.5) continue;
    const from = i;
    while (i+1 < PROFILE_BINS && p.volumes[i+1] < area.total/PROFILE_BINS*.5) i++;
    lowVolumeZones.push({ low: p.low+from*step, high: p.low+(i+1)*step });
  }
  const nearest = [...lowVolumeZones].sort((a,b) => Math.max(a.low-price,price-a.high,0)-Math.max(b.low-price,price-b.high,0))[0];
  const accepted = price >= val && price <= vah;
  // 多头观察分：POC 上方 6，价值区内 5，当前价非低成交量区 4。
  const points = (price >= poc ? 6 : 0)+(accepted ? 5 : 0)+(lowVolume ? 0 : 4);
  result.profile = { points, poc, val, vah, lowVolume, valueAreaCoverage: area.coverage, lowVolumeZones,
    label: lowVolume ? "低成交量区" : accepted ? "价值区内" : price > vah ? "价值区上方" : "价值区下方",
    reason: `成交分布（估算）：POC $${poc.toFixed(2)}；70% 价值区 $${val.toFixed(2)}–$${vah.toFixed(2)}；${nearest ? `${lowVolume ? "当前" : "最近"}低成交量区 $${nearest.low.toFixed(2)}–$${nearest.high.toFixed(2)}` : "无明显低成交量区"}` };
  return result;
}
