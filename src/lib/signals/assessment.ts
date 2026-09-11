import type { FundScore } from "@/lib/scoring/fundScore";
import { buyChartOf } from "@/lib/discord/signalTradeChart";
import type { AlertPayload } from "@/lib/discord/tvAlertCopy";

export const QUALITY_VERSION = "quality-v1";
export type QualityDimension = { name: string; points: number | null; max: number; reason: string };
export type EntryQuality = {
  version: typeof QUALITY_VERSION;
  points: number;
  available: number;
  complete: boolean;
  label: string;
  dimensions: QualityDimension[];
};
export type EntrySnapshot = {
  version: 1;
  id: string;
  capturedAt: string;
  payload: AlertPayload;
  quality: EntryQuality;
  rps?: number;
  fund?: FundScore;
};
export type AssessmentPanel = { heading: string; headline: string; lines: string[]; note: string };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n * 10) / 10;
const signed = (n: number, suffix = "%") => `${n >= 0 ? "+" : ""}${n.toFixed(2)}${suffix}`;

/** 观察性规则分，不改变交易决策；全部输入必须是买点当时可知的信息。 */
export function entryQualityOf(p: AlertPayload, rps?: number, fund?: FundScore): EntryQuality {
  const chart = buyChartOf(p.chart, p.barTime, p.price);
  const bars = chart?.stride === 1 ? chart.bars : undefined;
  const last = bars?.at(-1);
  const prior = bars && bars.length >= 11 ? bars.at(-11) : undefined;
  const dimensions: QualityDimension[] = [];
  const add = (name: string, max: number, points: number | null, reason: string) => dimensions.push({ name, max, points: points == null ? null : round(points), reason });
  if (last && prior && positive(p.atr) && [...last.slice(6), ...prior.slice(6)].every(positive)) {
    const fast = ((last[6] as number) + (last[7] as number)) / 2;
    const slow = ((last[8] as number) + (last[9] as number)) / 2;
    const fastSlope = (fast - ((prior[6] as number) + (prior[7] as number)) / 2) / p.atr;
    const slowSlope = (slow - ((prior[8] as number) + (prior[9] as number)) / 2) / p.atr;
    const aligned = Math.min(last[6] as number, last[7] as number) > Math.max(last[8] as number, last[9] as number);
    add("趋势", 30, (aligned ? 12 : 0) + 10 * clamp(fastSlope / .5) + 8 * clamp(slowSlope / .25),
      `${aligned ? "快通道在慢通道之上" : "通道未形成多头排列"}；近 10 根快线${fastSlope > 0 ? "上行" : "走平或下行"}`);
  } else add("趋势", 30, null, "缺少连续 K 线、Vegas 或 ATR");
  add("强度", 25, finite(rps) && rps >= 1 && rps <= 100 ? rps / 4 : null,
    finite(rps) && rps >= 1 && rps <= 100 ? `强于大池 ${Math.round(rps)}% 的股票` : "缺少当时的有效大池排名");
  if (last && positive(p.atr) && last.slice(6).every(positive)) {
    const channels = [[last[6] as number, last[7] as number], [last[8] as number, last[9] as number]];
    const support = channels.filter((c) => p.price >= Math.min(...c));
    const distance = support.length ? Math.min(...support.map((c) => Math.max(0, p.price - Math.max(...c)))) / p.atr : null;
    add("位置", 15, distance == null ? 0 : 15 * clamp(1 - distance / 4),
      distance == null ? "价格在两组通道下方" : `距下方最近 Vegas 通道 ${distance.toFixed(2)} ATR`);
  } else add("位置", 15, null, "缺少 Vegas 或 ATR，无法判断位置");
  const riskPct = positive(p.atr) && positive(p.stopMult) && positive(p.price) ? p.atr * p.stopMult / p.price * 100 : null;
  add("风险", 15, riskPct == null || riskPct >= 100 ? null : 15 * clamp((20 - riskPct) / 15),
    riskPct == null || riskPct >= 100 ? "缺少有效初始止损距离" : `参考初始风险 ${riskPct.toFixed(2)}%；未假设上涨目标`);
  const financial = fund?.dims.filter((d) => d.id !== "dist52w");
  const completeFinance = financial?.length === 5 && financial.every((d) => finite(d.value));
  add("财务", 15, completeFinance ? financial.reduce((sum, d) => sum + d.points, 0) / 85 * 15 : null,
    completeFinance ? "使用 5 项财务指标，不含接近新高" : `财务资料 ${financial?.filter((d) => finite(d.value)).length ?? 0}/5 项，不补估`);
  const points = round(dimensions.reduce((sum, d) => sum + (d.points ?? 0), 0));
  const available = dimensions.reduce((sum, d) => sum + (d.points == null ? 0 : d.max), 0);
  return { version: QUALITY_VERSION, points, available, complete: available === 100,
    label: available !== 100 ? "资料未齐" : points >= 80 ? "较强" : points >= 65 ? "中上" : points >= 50 ? "一般" : "偏弱", dimensions };
}

export function qualityPanel(q: EntryQuality, note?: string): AssessmentPanel {
  const position = q.dimensions.find((d) => d.name === "位置")!;
  const trend = q.dimensions.find((d) => d.name === "趋势")!;
  const risk = q.dimensions.find((d) => d.name === "风险")!;
  return { heading: "买点评分 · V1", headline: q.available ? `${q.points} / ${q.available} · ${q.label}` : "暂无评分 · 资料未齐",
    lines: [q.dimensions.map((d) => `${d.name} ${d.points == null ? "缺" : d.points}/${d.max}`).join(" · "),
      trend.reason, `${position.reason} · ${risk.reason}`],
    note: note ? `观察分非胜率；${note}` : "规则观察分，非胜率；缺项不补分、不折算为百分制" };
}

export const EXIT_REASONS = { initial_stop: "初始止损", protective_stop: "保本止损", trailing_stop: "移动止损", target: "目标止盈" } as const;
export type ExitReason = keyof typeof EXIT_REASONS;
export function signalReturnOf(p: AlertPayload): number | undefined {
  return positive(p.entry) && positive(p.price) ? (p.price / p.entry - 1) * 100 : undefined;
}
export function exitTitleOf(p: AlertPayload): string {
  if (p.exitReason === "trailing_stop" && (signalReturnOf(p) ?? 0) > 0) return "移动止盈";
  return p.exitReason && Object.hasOwn(EXIT_REASONS, p.exitReason) ? EXIT_REASONS[p.exitReason] : "卖点";
}

export function tradeReviewOf(p: AlertPayload, entry?: EntrySnapshot, journalNote?: string): AssessmentPanel {
  const pnl = signalReturnOf(p);
  const mismatch = pnl != null && finite(p.pnl) && Math.abs(pnl - p.pnl) > .05;
  const invalidStop = p.exitReason && p.exitReason !== "target" && (!positive(p.stop) || p.price >= p.stop);
  const invalidTarget = p.exitReason === "target" && (!positive(p.target) || p.price < p.target);
  const expectedRisk = entry && positive(entry.payload.atr) && positive(entry.payload.stopMult) ? entry.payload.atr * entry.payload.stopMult : undefined;
  const riskMismatch = expectedRisk != null && positive(p.initialRisk) && Math.abs(expectedRisk - p.initialRisk) > Math.max(.001, expectedRisk * .001);
  const validRisk = !riskMismatch && positive(p.initialRisk) && positive(p.entry) && p.initialRisk < p.entry;
  const r = pnl != null && validRisk ? (p.price - p.entry!) / p.initialRisk! : undefined;
  const validRange = positive(p.entry) && positive(p.highSinceEntry) && positive(p.lowSinceEntry) &&
    p.highSinceEntry >= Math.max(p.entry, p.price) - .0002 && p.lowSinceEntry <= Math.min(p.entry, p.price) + .0002 &&
    positive(p.entryTime) && positive(p.barTime) && p.barTime >= p.entryTime;
  const mfe = validRange ? Math.max(0, (p.highSinceEntry! / p.entry! - 1) * 100) : undefined;
  const mae = validRange ? Math.min(0, (p.lowSinceEntry! / p.entry! - 1) * 100) : undefined;
  const held = Number.isInteger(p.barsHeld) && p.barsHeld! > 0 && positive(p.entryTime) && positive(p.barTime) && p.barTime >= p.entryTime
    ? `${p.barsHeld} 根 · ${((p.barTime - p.entryTime) / 86400000).toFixed(1)} 天` : "持仓时长未记录";
  const q = entry?.quality;
  const headline = q ? `${q.available ? `入场 ${q.points}/${q.available} · ${q.label}` : "入场资料未齐"} → ${pnl == null ? "结果待核对" : signed(pnl)}` : `入场评分未记录 → ${pnl == null ? "结果待核对" : signed(pnl)}`;
  let verdict = !p.exitReason ? "旧版信号未记录退出原因，暂不评价执行。" :
    pnl == null ? "缺少有效开仓价，暂不评价结果。" :
    p.exitReason === "target" ? "价格达到预设目标，按规则触发退出。" :
    pnl > 0 ? "止损线抬升后触发退出，信号时仍有盈利。" : "触发保护性退出；单笔亏损不能说明入场规则无效。";
  if (mismatch || invalidStop || invalidTarget || riskMismatch) verdict = "数据口径异常：已按开仓价重算价格变化，退出评价暂缓。";
  return { heading: "交易复盘 · 截至卖出信号", headline,
    lines: [`${held} · 风险收益 ${r == null ? "未记录" : signed(r, " R")}`,
      mfe == null || mae == null || pnl == null ? "持仓最高/最低价未记录，无法计算浮盈与回撤" :
        `最大浮盈 ${signed(mfe)} · 最大浮亏 ${signed(mae)} · 回吐 ${Math.max(0, mfe - pnl).toFixed(2)} 个百分点`, verdict],
    note: journalNote ?? "开仓按策略模拟成交；当前为信号价变化，未计费用及下一根开盘价差" };
}
