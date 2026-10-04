import type { FundamentalHorizon, FundamentalState, FundamentalValuation } from "@/lib/fundamental/types";

const positive = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value) && value > 0;

export type ScenarioMarker = { key: "bear" | "base" | "bull" | "quote"; label: string; value: number; position: number };
export type ScenarioScale = { min: number; max: number; rangeStart: number; rangeWidth: number; markers: ScenarioMarker[] };

/** Geometry only: all published targets remain unchanged. Labels live outside the plotted lanes. */
export function scenarioScale(value: FundamentalHorizon, quote: number | null): ScenarioScale | null {
  if (![value.bear.target, value.base.target, value.bull.target].every(positive)) return null;
  const raw: Omit<ScenarioMarker, "position">[] = [
    { key: "bear", label: "Bear", value: value.bear.target },
    { key: "base", label: "Base", value: value.base.target },
    { key: "bull", label: "Bull", value: value.bull.target },
    ...(positive(quote) ? [{ key: "quote" as const, label: "留档价", value: quote }] : []),
  ];
  const low = Math.min(...raw.map(marker => marker.value)), high = Math.max(...raw.map(marker => marker.value));
  const padding = high === low ? Math.max(high * .05, 1) : (high - low) * .08;
  const min = Math.max(0, low - padding), max = Number.isFinite(high + padding) ? high + padding : high;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const position = (price: number) => 100 * ((price - min) / (max - min));
  const rangeStart = position(Math.min(value.bear.target, value.bull.target));
  return { min, max, rangeStart, rangeWidth: position(Math.max(value.bear.target, value.bull.target)) - rangeStart,
    markers: raw.map(marker => ({ ...marker, position: position(marker.value) })) };
}

export function targetSpace(target: number, quote: number | null): number | null {
  if (!positive(target) || !positive(quote)) return null;
  const value = (target / quote - 1) * 100;
  return Number.isFinite(value) ? value : null;
}

export function confidenceReadout(value: FundamentalValuation): string {
  return value.confidence === "low" ? "低 · V1 预设" : "中 · 模型标记";
}

/** Fallback text describes actual formula inputs only; it never synthesizes business claims. */
export function formulaReadout(value: FundamentalValuation, status: FundamentalState["analystStatus"]) {
  return {
    summary: `本次目标价由目标日期之后 12 个月的预期 EPS，与 ${value.peers.length} 家有效同业的 Forward P/E 样本共同计算。`,
    dependencies: ["盈利预测：使用分析师 Non-GAAP EPS 共识，按实际财年覆盖相应盈利窗口。", `估值倍数：以 ${value.peers.length} 家已核验同业的预期市盈率为参考。`],
    uncertainties: ["盈利预测与同业定价水平都可能变化；情景区间不是价格承诺。", "样本有限，情景权重为模型预设，尚未经过实证概率校准。"],
    aiStatus: status === "unavailable" ? "本轮 AI 解读未成功，以下仅说明已保存公式的依赖。" : status === "not-requested" ? "本版未请求 AI 解读，以下仅说明已保存公式的依赖。" : "暂无可展示的已保存 AI 解读，以下仅说明公式依赖。",
  };
}
