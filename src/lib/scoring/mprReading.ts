import type { MacroPhaseSnapshot } from "@/lib/dashboard/mpr";

/**
 * 把 MPR 的原版路径翻译成可展示的判读。
 *
 * 存在的理由是原版有两处不能直接展示给用户：
 *
 * 1. Path 0「稳态自洽」是 else 兜底分支。当 spyDamage 落在 [60,70) 且三域承压时，
 *    四个分支全不匹配，会掉进这里并被标为「健康顺风·建议敞口 80~100%」。
 *    真实历史上 63.1% 的 Path 0 属于这种情况。此处按三域压力还原真实含义。
 * 2. 3928 个交易日的校准显示路径分级对 5 日方向没有预测力，只有 Path 4 的
 *    尾部风险有统计意义。因此判读一律不给方向和仓位建议。
 *
 * 详见 docs/plans/2026-08-21-quant-integration-roadmap.md 的未决问题 4。
 */

export type MacroReadingTone = "positive" | "caution" | "warning" | "danger";

export type MacroReading = {
  pathLabel: string;
  tone: MacroReadingTone;
  headline: string;
  detail: string;
  /** Path 0 是否为兜底落入（三域并非全静）。 */
  isPathZeroFallthrough: boolean;
};

/** σ 分级的「异动」门槛，与 Pine 一致。 */
const SIGMA_ACTIVE = 50;

const PATH_LABEL: Record<number, string> = {
  0: "P0 稳态自洽",
  1: "P1 跨市场暗流",
  2: "P2 相变扩散",
  3: "P3 微观漂移",
  4: "P4 破位确认",
};

export function macroPhaseReading(day: MacroPhaseSnapshot): MacroReading {
  const activeDomains = [day.domVol, day.domCred, day.domSpot].filter((v) => v >= SIGMA_ACTIVE);
  const isPathZeroFallthrough = day.pathId === 0 && activeDomains.length > 0;
  const pathLabel = PATH_LABEL[day.pathId] ?? `P${day.pathId}`;

  if (isPathZeroFallthrough) {
    return {
      pathLabel,
      tone: "warning",
      headline: `承压未定 · ${activeDomains.length} 个域异动`,
      detail:
        "原版判定树在此区间有覆盖空洞，会误标为稳态。实为大盘已回撤且有域承压，但未达任一路径的触发条件。",
      isPathZeroFallthrough: true,
    };
  }

  switch (day.pathId) {
    case 0:
      return {
        pathLabel,
        tone: "positive",
        headline: "三域全静",
        detail: "衍生品、信用、现货三域压力均低于异动门槛。历史上此类日仅占 12.8%。",
        isPathZeroFallthrough: false,
      };
    case 1:
      return {
        pathLabel,
        tone: "caution",
        headline: "衍生品或信用域先动",
        detail:
          "现货尚未反应。校准显示该路径后续 5 日下跌频率 29.1%，低于 39.1% 的全样本基准，历史上并非看空信号。",
        isPathZeroFallthrough: false,
      };
    case 2:
      return {
        pathLabel,
        tone: "warning",
        headline: "压力已扩散至现货",
        detail:
          "该路径占全部交易日 35.3%，触发频繁；后续 5 日下跌频率 38.0%，与基准无显著差异。",
        isPathZeroFallthrough: false,
      };
    case 3:
      return {
        pathLabel,
        tone: "caution",
        headline: "仅现货域异动",
        detail: "衍生品与信用域平静，压力尚未跨市场传导。",
        isPathZeroFallthrough: false,
      };
    case 4:
      return {
        pathLabel,
        tone: "danger",
        headline: "高波动区制",
        detail:
          "后续 5 日跌幅超 3% 的概率 11.9%，约为其他路径的 3~4 倍；但平均收益同样最高（+0.59%），是波动放大而非方向看空。",
        isPathZeroFallthrough: false,
      };
    default:
      return {
        pathLabel,
        tone: "caution",
        headline: "未知路径",
        detail: "路径编号超出 0~4，请检查计算逻辑。",
        isPathZeroFallthrough: false,
      };
  }
}
