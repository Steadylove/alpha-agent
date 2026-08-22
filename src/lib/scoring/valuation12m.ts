/**
 * 12M 动态估值引擎与标的基因判定。
 *
 * 对齐「MarketCompass」Pine 第 9~10 节。
 *
 * 输出 `primaryTarget`（12 个月目标价）与 `upsidePct`。后者只喂
 * `isDipActive` 这一个仲裁标志（Pine 第 587 行），不参与形态闸、风控与战术指令。
 *
 * ## 两处需要留意的实现事实
 *
 * **1. 五条分支里有四条在代数上等于对现价的固定加成。**
 *
 * 两个 PS 模型（Pine 第 518~521、542~545 行）写作
 * `rev_per_share = rev/shares`、`current_ps = close/rev_per_share`、
 * `target = rev_per_share * current_ps * k`，展开即 `close * k`——营收与股本完全约掉。
 * 因此 `revTtm` 与 `sharesOutstanding` **不影响结果数值**，只决定能否走这条分支。
 *
 * 同理，`target = eps * (current_pe * k)` 展开是 `eps * (close/eps) * k = close * k`。
 * 所以「高 PE 动态扩展」（k=1.18）与「动能估值扩张」（k=1.20）在 PE 上限**不生效时**
 * 也退化成现价加成，只有撞上 75 / 42 / 55 这几个封顶值才真正用到 EPS。
 *
 * 真正独立于现价的只有两条：PEG 模型与市值基准 PE，它们用绝对 PE 乘 EPS。
 *
 * **2. 因此目标价与「估值」关系不大。** 大部分时间锚点就是当前价格本身，
 * 末尾的「防倒挂」还会在强势标的上强制把目标顶到 `close * 1.22`。
 * 它更接近一个动能强度的价格投影，不是独立于价格的内在价值估计。
 */

import type { StockStage } from "./stockStage";

/** Pine 第 19~20 行的 input 默认值。 */
export const PEG_TARGET = 1.0;
export const MAX_PE_MID = 60.0;

export type ValuationMode =
  /** 长期下行 + 大盘股：EMA200 + 2×ATR 均值修复 */
  | "leader_mean_reversion"
  /** 长期下行 + 中小盘：PE 22 保守模型 */
  | "bear_conservative"
  /** 高 PE + 有营收：PS 重估（实为 close × 1.20/1.12） */
  | "ps_revaluation"
  /** 高 PE 无营收数据：当前 PE × 1.18，封顶 75 */
  | "high_pe_expansion"
  /** 单季 EPS 同比 > 15%：PEG 模型 */
  | "peg_growth"
  /** 超级动能：当前 PE × 1.20，按市值分档封顶 */
  | "momentum_expansion"
  /** 万亿体量基准 PE 30 */
  | "trillion_baseline_pe"
  /** 稳健成长基准 PE 35 / 25 */
  | "steady_growth_pe"
  /** 无 EPS 但有营收：动态 PS（实为 close × 1.25/1.12） */
  | "dynamic_ps"
  /** 强势标的目标价低于现价时的强制上顶 */
  | "anti_inversion"
  /** 万亿体量 +35% 上限压制 */
  | "trillion_cap"
  /** 目标价低于现价一半时的兜底 */
  | "structural_floor"
  /** 完全无基本面：(EMA200 + 4×ATR) × macro_mult */
  | "technical_fallback";

export type StockArchetype =
  | "value_trend"
  | "tech_only"
  | "high_beta_growth"
  | "growth_premium"
  | "distribution";

export interface ValuationInput {
  close: number;
  /** Pine 的 current_atr，即 sma(ATR14, 252) */
  atr: number;
  ema200: number | null;
  trendScore: number;
  /** dailyRSRating，1~99 */
  rs: number;
  stage: StockStage;
  isInLongDowntrend: boolean;
  isHyperMomentum: boolean;
  /** MPR 的 FSM 状态，决定宏观折价系数 */
  fsmState: number;
  pathId: number;

  epsTtm: number | null;
  revTtm: number | null;
  sharesOutstanding: number | null;
  marketCap: number | null;
  epsQYoY: number | null;
  analystTarget: number | null;
  analystCount: number;
}

export interface ValuationVerdict {
  primaryTarget: number;
  upsidePct: number;
  mode: ValuationMode;
  /** 是否被分析师共识拉平过（Pine 的「(共识平滑)」后缀） */
  consensusSmoothed: boolean;
  archetype: StockArchetype;
  currentPe: number | null;
  /** 该分支实际采用的目标 PE，PS 系分支为 null */
  calculatedPe: number | null;
  marketCapB: number | null;
  /** Pine 第 587 行：上行空间 >= 15% 且宏观未破位 */
  isDipActive: boolean;
}

export type SqueezeTier = "extreme" | "warning" | "swing";

export interface ShortTermTarget {
  /** Pine 第 635 行：close + 2 × current_atr × squeeze_mult */
  target: number;
  /** 空头持仓占总股本的百分比，数据缺失时为 0（Pine 的 na 兜底） */
  shortRatioPct: number;
  tier: SqueezeTier;
}

/**
 * Pine 第 632~635 行的轧空短线目标价。
 *
 * **数据源受限：** Pine 用 `request.financial(..., "SHORT_INTEREST", "FQ")`，
 * 而 FMP 的 stable 接口没有 short interest（`shares-float` 只给流通股本），
 * Yahoo 的 quoteSummary 需要 crumb + cookie 会话、易碎不值得引入。
 *
 * 因此 `shortInterest` 恒为 null，走的是 Pine 自己的 na 分支：
 * `short_ratio_pct = 0` → `squeeze_mult = 1.0` → 目标价退化为 `close + 2×ATR`，
 * 档位恒为「波段」。8% 与 15% 两档轧空在当前数据条件下永远不会触发。
 */
export function shortTermTarget(
  close: number,
  /** Pine 的 current_atr，即 sma(ATR14, 252) */
  atr: number,
  shortInterest: number | null,
  sharesOutstanding: number | null,
): ShortTermTarget {
  const shortRatioPct =
    shortInterest != null && sharesOutstanding != null && sharesOutstanding > 0
      ? (shortInterest / sharesOutstanding) * 100
      : 0;

  const mult = shortRatioPct >= 15 ? 1.8 : shortRatioPct >= 8 ? 1.35 : 1.0;
  const tier: SqueezeTier =
    shortRatioPct >= 15 ? "extreme" : shortRatioPct >= 8 ? "warning" : "swing";

  return { target: close + 2 * atr * mult, shortRatioPct, tier };
}

/** Pine 第 462 行：FSM 状态决定的宏观折价。 */
export function macroMultiplier(fsmState: number): number {
  if (fsmState === 3) return 0.85;
  if (fsmState === 2) return 0.92;
  if (fsmState === 0) return 1.05;
  return 1.0;
}

function archetypeOf(input: ValuationInput, currentPe: number | null): StockArchetype {
  const { epsTtm, trendScore, rs, stage } = input;

  if (epsTtm == null || epsTtm <= 0) {
    return trendScore <= 4 || rs < 45 ? "tech_only" : "high_beta_growth";
  }
  if (currentPe != null && currentPe >= 45) return "growth_premium";
  if (stage === "C") return "distribution";
  return "value_trend";
}

/** 级联主体，返回 macro_mult 之前的原始目标价。 */
function rawTarget(
  input: ValuationInput,
  currentPe: number | null,
  isLargeTier: boolean,
  isTrillionCap: boolean,
): { target: number | null; mode: ValuationMode | null; pe: number | null } {
  const { close, atr, ema200, epsTtm, revTtm, sharesOutstanding, epsQYoY, rs } = input;
  const hasRevenue = revTtm != null && sharesOutstanding != null && sharesOutstanding > 0;

  if (input.isInLongDowntrend) {
    if (isLargeTier) {
      return {
        target: (ema200 ?? close) + 2 * atr,
        mode: "leader_mean_reversion",
        pe: null,
      };
    }
    return {
      target: epsTtm != null && epsTtm > 0 ? epsTtm * 22 : close * 0.85,
      mode: "bear_conservative",
      pe: 22,
    };
  }

  if (epsTtm != null && epsTtm > 0) {
    const isHighPeGrowth = currentPe != null && currentPe >= 40;

    if (isHighPeGrowth && hasRevenue) {
      // rev_per_share 与 current_ps 相乘后约掉，等价于 close × 系数
      return { target: close * (rs >= 75 ? 1.2 : 1.12), mode: "ps_revaluation", pe: null };
    }
    if (isHighPeGrowth) {
      const pe = Math.min(currentPe! * 1.18, 75);
      return { target: epsTtm * pe, mode: "high_pe_expansion", pe };
    }
    if (epsQYoY != null && epsQYoY > 0.15) {
      const gRate = Math.min(epsQYoY * 100, 50);
      const pe = Math.min(Math.max(gRate * PEG_TARGET, 18), MAX_PE_MID);
      return { target: epsTtm * pe, mode: "peg_growth", pe };
    }
    if (input.isHyperMomentum) {
      const cap = isLargeTier ? 42 : 55;
      const pe = Math.min((currentPe ?? 0) * 1.2, cap);
      return { target: epsTtm * pe, mode: "momentum_expansion", pe };
    }
    const pe = isTrillionCap ? 30 : isLargeTier ? 35 : 25;
    return {
      target: epsTtm * pe,
      mode: isTrillionCap ? "trillion_baseline_pe" : "steady_growth_pe",
      pe,
    };
  }

  if (hasRevenue) {
    return {
      target: close * (input.isHyperMomentum ? 1.25 : 1.12),
      mode: "dynamic_ps",
      pe: null,
    };
  }

  return { target: null, mode: null, pe: null };
}

export function computeValuation(input: ValuationInput): ValuationVerdict {
  const { close, atr, ema200, epsTtm, analystTarget, analystCount } = input;

  const currentPe = epsTtm != null && epsTtm > 0 ? close / epsTtm : null;
  const marketCapB = input.marketCap != null ? input.marketCap / 1e9 : null;
  const isTrillionCap = marketCapB != null && marketCapB >= 1000;
  const isLargeTier = marketCapB != null && marketCapB >= 200;

  const mult = macroMultiplier(input.fsmState);
  const base = rawTarget(input, currentPe, isLargeTier, isTrillionCap);

  let target = base.target != null ? base.target * mult : null;
  let mode = base.mode;
  let pe = base.pe;

  // 防倒挂：强势标的的目标价不允许低于现价
  const isStrong = input.isHyperMomentum || input.rs >= 70 || input.trendScore >= 7;
  if (isStrong && !input.isInLongDowntrend && (target == null || target < close)) {
    target = close * 1.22;
    mode = "anti_inversion";
    pe = null;
  }

  let consensusSmoothed = false;
  if (target != null && analystTarget != null && analystTarget > 0 && analystCount >= 3) {
    const spread = Math.abs(target - analystTarget) / analystTarget;
    if (spread > 0.25) {
      target = 0.5 * target + 0.5 * analystTarget;
      consensusSmoothed = true;
    }
  }

  if (isTrillionCap && !input.isHyperMomentum && target != null) {
    const cap = close * 1.35;
    if (target > cap) {
      target = cap;
      mode = "trillion_cap";
      pe = null;
    }
  }

  if (target != null && target < close * 0.5) {
    target = close * 0.95;
    mode = "structural_floor";
    pe = null;
  }

  let primaryTarget: number;
  if (target != null) {
    primaryTarget = target;
  } else {
    primaryTarget = ((ema200 ?? close) + 4 * atr) * mult;
    mode = "technical_fallback";
    pe = null;
  }
  if (!Number.isFinite(primaryTarget) || primaryTarget <= 0) {
    primaryTarget = close * 1.15;
    mode = "technical_fallback";
    pe = null;
  }

  const upsidePct = close > 0 ? ((primaryTarget - close) / close) * 100 : 0;

  return {
    primaryTarget,
    upsidePct,
    mode: mode ?? "technical_fallback",
    consensusSmoothed,
    archetype: archetypeOf(input, currentPe),
    currentPe,
    calculatedPe: pe,
    marketCapB,
    isDipActive: upsidePct >= 15 && input.pathId !== 4,
  };
}
