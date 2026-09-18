import { buyChartOf } from "@/lib/discord/signalTradeChart";
import type { AlertPayload, AlertView } from "@/lib/discord/tvAlertCopy";
import { entryQualityOf, qualityGrade, qualityPanel, type EntryQuality, type QualityDimension } from "./assessment";
import { candidatePositionOf } from "./positionCandidate";
import { sectorFactorOf, type SectorSnapshot } from "./sectorFactor";
import { volumeFactorsOf } from "./volumeFactors";

export const CANDIDATE_WEIGHTS = { strength: 30, position: 25, cvd: 20, sector: 15, profile: 10 } as const;
export type CandidateContext = { sector?: SectorSnapshot; asOf?: string; replay?: boolean };
export type CandidateAssessment = ReturnType<typeof candidateAssessmentOf>;
export function candidateAssessmentOf(p: AlertPayload, rps?: number, context: CandidateContext = {}) {
  const baseline = entryQualityOf(p, rps), chart = buyChartOf(p.chart, p.barTime, p.price);
  const position = candidatePositionOf(chart?.stride === 1 ? chart.bars : undefined, p.price, p.atr);
  const sector = sectorFactorOf(context.sector, p.symbol, context.asOf, p.barTime, context.replay);
  const old = (name: string) => baseline.dimensions.find(d => d.name === name)!;
  const dimensions: QualityDimension[] = [old("强度"), { name: "位置", max: 25, points: position.points, reason: position.reason },
    { ...old("CVD背离"), name: "量价压力" }, { name: "板块共振", max: 15, points: sector.points, reason: sector.reason }, old("成交分布")];
  const points = Math.round(dimensions.reduce((sum, d) => sum + (d.points ?? 0), 0) * 10) / 10;
  const available = dimensions.reduce((sum, d) => sum + (d.points == null ? 0 : d.max), 0);
  const quality: EntryQuality = { version: "quality-v5", points, available, complete: available === 100, label: qualityGrade(points, available), dimensions };
  const stopDistance = p.atr && p.stopMult && p.price > 0 ? p.atr * p.stopMult : undefined;
  return { quality, baseline, position, sector, raw: { rps, volume: volumeFactorsOf(p.volumeSnapshot, p.barTime, p.price) },
    risk: { stopDistance, stopPrice: stopDistance == null ? undefined : p.price - stopDistance,
      stopPct: stopDistance == null ? undefined : 100 * stopDistance / p.price }, replay: context.replay === true };
}

/** 可视化候选，不写交易日志、不修改入场门槛，不发送告警。 */
export function candidatePreviewView(view: AlertView, candidate: CandidateAssessment): AlertView {
  return { ...view, quality: candidate.quality, assessment: qualityPanel(candidate.quality), candidate,
    footer: "历史真实买点 · V5候选重算" };
}

/** 风险预算独立于买点质量；只是按止损价估计股数，跳空/费用可能增加实际损失。 */
export function sharesForRiskBudget(budget: number, price: number, stop: number): number | null {
  if (![budget, price, stop].every(Number.isFinite) || budget <= 0 || stop <= 0 || stop >= price) return null;
  return Math.floor(budget / (price - stop));
}
