/**
 * MPR 原版的文字输出层：拓扑路径、相变分级、致险因子排序与实战指引。
 *
 * 对齐「Market Phase Radar」Pine 第 197~289 行。
 *
 * ## 与 `mprReading.ts` 的分工
 *
 * 本模块是 Pine 原文的**忠实移植**，会给出明确的方向与仓位建议。
 * `mprReading.ts` 则是基于 3928 个交易日校准后的判读，刻意不给方向——
 * 校准显示路径分级对 5 日方向没有预测力，只有 Path 4 的尾部风险有统计意义。
 *
 * 两者并存是有意的：界面上把原版指引标注为「原版口径」与校准判读并列展示，
 * 既满足了对齐规格的要求，也不丢掉证据。不要拿本模块的结论去驱动任何自动交易。
 */

import { PATH_EXPOSURE } from "./macroExposure";

export type MprTone = "positive" | "caution" | "warning" | "danger";

/** Pine 第 197~219 行的拓扑路径描述与建议敞口。 */
export type PathTopology = {
  label: string;
  tone: MprTone;
  /** 「0% ~ 20% (现金防御)」这样的原文格式 */
  exposureText: string;
};

const PATH_TOPOLOGY: Record<number, { label: string; tone: MprTone }> = {
  0: { label: "🟢 [稳态自洽] 三大域共振健康顺风", tone: "positive" },
  1: { label: "⚠️ [跨市场暗流] 期权/信用异动（现货暂稳）", tone: "caution" },
  2: { label: "🚨 [相变扩散] 衍生品/信用 ➔ 现货广度扩散", tone: "danger" },
  3: { label: "🟡 [微观漂移] 现货放量滞涨（底层平静）", tone: "caution" },
  4: { label: "🔴 [破位确认] 全市场力场同步坍塌", tone: "danger" },
};

export function pathTopology(pathId: number): PathTopology {
  const topo = PATH_TOPOLOGY[pathId] ?? PATH_TOPOLOGY[4];
  const band = PATH_EXPOSURE[pathId] ?? PATH_EXPOSURE[4];
  return {
    label: topo.label,
    tone: topo.tone,
    exposureText: `${band.minPct}% ~ ${band.maxPct}% (${band.stance})`,
  };
}

/** Pine 第 221~240 行的相变分级。 */
export type TransitionGrade = {
  /** T0~T4 */
  label: string;
  desc: string;
  tone: MprTone;
};

const TRANSITION: Record<number, TransitionGrade> = {
  0: { label: "T0 稳态自洽", desc: "底层力场健康，无背离迹象", tone: "positive" },
  1: { label: "T2 前相变预警", desc: "⚠️ 衍生品/信用异动，主力防守", tone: "warning" },
  2: { label: "T3 相变临界", desc: "🚨 暗流侵蚀现货广度，随时补跌", tone: "danger" },
  3: { label: "T1 行为漂移", desc: "⚡ 推进效率衰竭，高位滞涨", tone: "caution" },
  4: { label: "T4 价格已确认", desc: "大盘破位下跌已成事实", tone: "danger" },
};

export function transitionGrade(pathId: number): TransitionGrade {
  return TRANSITION[pathId] ?? TRANSITION[0];
}

/**
 * Pine 第 249~275 行：五个力场按压力降序排列，取前两名。
 *
 * Pine 用的是冒泡排序，且外层只跑到 `i = 0 to 3`、内层 `j = 0 to 3 - i`，
 * 恰好是完整的 5 元素冒泡，结果与直接降序排序一致。
 */
export type ForceReading = { name: string; value: number };

export function topRiskFactors(f: {
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  f5: number;
}): ForceReading[] {
  // 数组初始顺序取自 Pine，同值时决定先后
  const forces: ForceReading[] = [
    { name: "F2 期权期限倒挂", value: f.f2 },
    { name: "F5 领头羊广度背离", value: f.f5 },
    { name: "F4 信用利差紧缩", value: f.f4 },
    { name: "F1 高位放量滞涨", value: f.f1 },
    { name: "F3 宏观避险脱节", value: f.f3 },
  ];
  // Pine 的冒泡是稳定排序，同值保持初始顺序
  return forces
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v.value - a.v.value || a.i - b.i)
    .map((x) => x.v)
    .slice(0, 2);
}

/** Pine 第 277~289 行的实战指引。弱势个股分支需要当前标的的 4Q-Alpha 读数。 */
export type SymbolContext = {
  /** MPR 口径的 4Q-Alpha 评分，1~99 */
  rsRating: number;
  /** EMA50 < EMA200 且收盘价低于 EMA200 */
  inDowntrend: boolean;
};

export function actionText(pathId: number, symbol?: SymbolContext): string {
  if (pathId === 4) {
    return "🔴【全面破位】全市场流动性坍塌 ➔ 现金防御，严禁左侧抄底接飞刀！";
  }
  if (pathId === 2) {
    return "🚨【临界扩散】暗流已侵蚀现货广度 ➔ 严禁追多，推高移动止损，分批锁定！";
  }
  if (pathId === 1) {
    return "⚠️【跨市场暗流】期权/信用率先异动 ➔ 降低风险敞口，严守保本纪律。";
  }
  // Pine 把个股弱势判定插在 Path 1 与 Path 3 之间，优先级高于微观滞涨
  if (symbol && (symbol.rsRating < 30 || symbol.inDowntrend)) {
    return "❄️【弱势个股】该股 4Q-Alpha 评分极弱或空头排列 ➔ 严禁逆势买入弱势标的！";
  }
  if (pathId === 3) {
    return "🟡【微观滞涨】出现高位放量分化 ➔ 保持警惕，推高移动止损，勿激进追高。";
  }
  return "🟢【多头顺风】三大物理域共振健康 ➔ 环境优良，积极做多强势领涨主线！";
}
