/**
 * 「商业化产品架构闭环」独有规则的总开关。
 *
 * ## 为什么单独收在这里
 *
 * `轻量级量化投研/` 下的四份文档并不自洽。三份 Pine 是**可执行**规格，
 * 商业化文档是**产品愿景**，两者在四处直接冲突：
 *
 * | 规则 | 商业化文档 | 两份 Pine | 本项目现状 |
 * | --- | --- | --- | --- |
 * | RS 算法 | 全池 PercentileRank | 逐股饱和映射 | 饱和映射 |
 * | 入场门槛 | RS>=70 入场、RS<40 否决 | 无 RS 门槛（只有默认关的 RSI>30） | minRs=30（自加校准项） |
 * | 保本触发 | 常态 +10%，Path2 或 P(5D跌)>=60% 时提前到 +5% | 只有 +10% | +10% |
 * | 组合权重 | E_macro(Path) × RS_i/ΣRS_j | RS_i/ΣRS_j | RS_i/ΣRS_j |
 *
 * 已确认的口径是 **Pine 为准**，因此这些开关全部默认关闭，现有回测结论不受影响。
 * 需要对齐商业化文档时在这里逐项打开，改完重跑对应任务即可，无需改代码。
 *
 * 打开后必须重跑受影响的任务才会体现到库里：前三项改的是 `rotation-radar`
 * 与 `stock-panel` 的写入结果，第四项只影响读取时的看板计算。
 *
 * ## 一处有反向证据的开关
 *
 * `macroExposureScaling` 不只是「没实现」——组合层回测（3927 日、已去除未来函数）
 * 显示照 E_macro 机械减仓会让收益/波动从 1.18 降到 0.95。打开前请重跑回测。
 */

export type CommercialSpecFlags = {
  /**
   * RS 改用全池截面分位排名，而非逐股饱和映射。
   * 生效于 `jobs/rotationRadar.ts`（需要基准 SPY）。
   */
  percentileRs: boolean;
  /**
   * 轮动入场要求 RS>=70，且 RS<40 一票否决清仓。
   * 生效于 `jobs/rotationRadar.ts`。
   */
  rsEntryVeto: boolean;
  /**
   * Path 2 或 5 日下跌概率 >= 60% 时，保本触发从 +10% 提前到 +5%。
   * 生效于 `jobs/rotationRadar.ts` 与 `jobs/stockPanel.ts` 两套风控引擎。
   */
  earlyBreakeven: boolean;
  /**
   * 组合权重乘以 E_macro(Path) 敞口系数。
   * 生效于 `dashboard/rotation.ts`。
   */
  macroExposureScaling: boolean;
};

export const COMMERCIAL_SPEC: CommercialSpecFlags = {
  percentileRs: false,
  rsEntryVeto: false,
  earlyBreakeven: false,
  macroExposureScaling: false,
};

/** 商业化文档第 217 行：提前保本的宏观触发条件。 */
export function isEarlyBreakevenCondition(pathId: number, prob5dDown: number): boolean {
  return pathId === 2 || prob5dDown >= 60;
}
