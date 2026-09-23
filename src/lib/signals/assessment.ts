import type { RpsEvidence } from "@/lib/backtest/rpsSnapshot";
import type { FundScore } from "@/lib/scoring/fundScore";
import { buyChartOf } from "@/lib/discord/signalTradeChart";
import type { AlertPayload } from "@/lib/discord/tvAlertCopy";
import { qualityDimensionLabel, qualityReasonText } from "./qualityCopy";
import { volumeFactorsOf } from "./volumeFactors";
import { positionFactorOf } from "./positionFactor";
import type { CandidateAssessment } from "./candidateAssessment";

export const QUALITY_VERSION = "quality-v5";
export const BASELINE_QUALITY_VERSION = "quality-v4";
/** 结构性观察权重，尚未经过样本外收益标定；原生指标先归一化再加权。 */
export const BASELINE_QUALITY_WEIGHTS = { cvd: 20, strength: 30, position: 25, risk: 15, profile: 10 } as const;
export type QualityDimension = { name: string; points: number | null; max: number; reason: string };
export type EntryQuality = {
  version: "quality-v1" | "quality-v2" | "quality-v3" | typeof BASELINE_QUALITY_VERSION | typeof QUALITY_VERSION;
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
  /** V5 原始特征和独立风险；旧 V4 记录中的候选不能替换其冻结 quality。 */
  candidate?: CandidateAssessment;
  rps?: number;
  rpsEvidence?: RpsEvidence;
  fund?: FundScore;
  /** 信号前已发布的最近一份市场复盘；不使用当日收盘后的市场状态。 */
  marketContext?: import("@/lib/review/types").MarketContext;
};
export type AssessmentPanel = { heading: string; headline: string; lines: string[]; note: string };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n * 10) / 10;
const signed = (n: number, suffix = "%") => `${n >= 0 ? "+" : ""}${n.toFixed(2)}${suffix}`;
const weighted = (points: number | null, originalMax: number, weight: number) => points == null ? null : weight * clamp(points / originalMax);
export const qualityVersionLabel = (version: EntryQuality["version"]) => version.replace("quality-v", "V");

/** 保留 V4 对照算法；正式买点使用 V5，历史冻结评分不重算。 */
export function baselineEntryQualityOf(p: AlertPayload, rps?: number, _legacyFund?: FundScore): EntryQuality {
  const chart = buyChartOf(p.chart, p.barTime, p.price);
  const bars = chart?.stride === 1 ? chart.bars : undefined;
  const volume = volumeFactorsOf(p.volumeSnapshot, p.barTime, p.price);
  const dimensions: QualityDimension[] = [];
  const add = (name: string, max: number, points: number | null, reason: string) => dimensions.push({ name, max, points: points == null ? null : round(points), reason });
  const weights = BASELINE_QUALITY_WEIGHTS;
  add("CVD背离", weights.cvd, weighted(volume.cvd.points, 30, weights.cvd), volume.cvd.reason);
  add("强度", weights.strength, finite(rps) && rps >= 1 && rps <= 100 ? weights.strength * rps / 100 : null,
    finite(rps) && rps >= 1 && rps <= 100 ? `强于大池 ${Math.round(rps)}% 的股票` : "缺少当时的有效大池排名");
  const position = positionFactorOf(bars, p.price, p.atr, weights.position);
  add("位置", weights.position, position.points, position.reason);
  const riskPct = positive(p.atr) && positive(p.stopMult) && positive(p.price) ? p.atr * p.stopMult / p.price * 100 : null;
  add("风险", weights.risk, riskPct == null || riskPct >= 100 ? null : weights.risk * clamp((20 - riskPct) / 15),
    riskPct == null || riskPct >= 100 ? "缺少有效初始止损距离" : `参考初始风险 ${riskPct.toFixed(2)}%；未假设上涨目标`);
  add("成交分布", weights.profile, weighted(volume.profile.points, 15, weights.profile), volume.profile.reason);
  const points = round(dimensions.reduce((sum, d) => sum + (d.points ?? 0), 0));
  const available = dimensions.reduce((sum, d) => sum + (d.points == null ? 0 : d.max), 0);
  return { version: BASELINE_QUALITY_VERSION, points, available, complete: available === 100,
    label: qualityGrade(points, available), dimensions };
}

export function qualityGrade(points: number, available = 100): string {
  return available !== 100 ? "资料未齐" : points >= 80 ? "优秀" : points >= 65 ? "良好" : points >= 50 ? "一般" : "偏弱";
}

export function qualityPanel(q: EntryQuality, note?: string): AssessmentPanel {
  const headline = q.available ? `${q.points} / ${q.available} · ${q.label}` : "暂无评分 · 资料未齐";
  if (q.version === QUALITY_VERSION) return { heading: "买点评分 · V5", headline,
    lines: q.dimensions.map(d => `${d.name} ${d.points ?? "缺"}/${d.max} · ${d.reason}`),
    note: `规则观察分，非胜率；分钟量价估算，非逐笔主动买卖；缺项不补分；止损独立于质量分${note ? `；${note}` : ""}` };
  const currentVersion = qualityVersionLabel(QUALITY_VERSION);
  if (q.version === "quality-v1") return { heading: "历史入场评分 · V1", headline,
    lines: ["保留当时总分；旧告警未采集新指标，不使用后来的数据重算。"], note: note ?? `历史规则观察分，非胜率；与 ${currentVersion} 分数不直接比较` };
  const reason = (name: string) => q.dimensions.find((d) => d.name === name)?.reason ?? "资料未齐";
  return { heading: `历史入场评分 · ${qualityVersionLabel(q.version)}`, headline,
    lines: [q.dimensions.map((d) => `${qualityDimensionLabel(d.name)} ${d.points == null ? "缺" : d.points}/${d.max}`).join(" · "),
      reason("CVD背离"), reason("成交分布"), `${reason("位置")} · ${qualityReasonText(reason("风险"))}`],
    note: `规则观察分，非胜率；分钟量价估算，非逐笔主动买卖；缺项不补分；保留历史算法和权重，与 ${currentVersion} 不直接比较${note ? `；${note}` : ""}` };
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
