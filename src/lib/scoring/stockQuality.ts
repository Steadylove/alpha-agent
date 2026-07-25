import type { FundamentalSnapshot } from "@/lib/data-sources/fmp";
import {
  eventRatio,
  highestHigh,
  maxDrawdownRecent,
  percentChange,
  percentileRank,
  simpleMovingAverage,
  upDayRatio,
} from "@/lib/scoring/indicators";
import type { DailyBar } from "@/lib/types/market";

export type MomentumBreakdown = {
  score: number; // 0~15
  weightedRps: number | null;
  rps21: number | null;
  rps63: number | null;
  rps252: number | null;
  acceleration: number | null;
  eventRatio: number | null;
  weightedRpsScore: number; // 0~8
  accelerationScore: number; // 0~4
  eventScore: number; // 0~3
};

export type TrendBreakdown = {
  score: number; // 0~10
  stackedMa: boolean;
  proximityToHigh: number | null;
  upDayRatio63: number | null;
  drawdown3m: number | null;
  maHighScore: number; // 0~4
  upDayScore: number; // 0~3
  drawdownScore: number; // 0~3
};

export type FundamentalBreakdown = {
  score: number; // 0~25
  hasData: boolean;
  vetoed: boolean;
  epsRevision: number | null;
  revenueGrowth: number | null;
  grossMargin: number | null;
  roic: number | null;
  growthScore: number; // 0~8
  profitScore: number; // 0~7
  revisionScore: number; // 0~5
  moatScore: number; // 0~5（Wave 3 · LLM 1-5；缺失兜底 3）
  moatReason: string | null; // Wave 3 · LLM 一句话依据
  moatSource: "llm" | "fallback"; // 打分来源
};

// ──────────────── Momentum Quality 15 ────────────────

export function computeMomentum(
  bars: DailyBar[],
  rps21: number,
  rps63: number,
  rps252: number,
): MomentumBreakdown {
  const weightedRps = 0.5 * rps63 + 0.3 * rps21 + 0.2 * rps252;
  // v3: 多周期加权 8 分（不再有 90 门槛的暴力阶跃，改线性）
  const weightedRpsScore = Math.round((Math.max(0, Math.min(100, weightedRps)) / 100) * 8);

  // v3: 加速度 4 分线性 clamp（消除 rps21>rps63 二值阶跃）
  const acceleration = rps21 - rps63;
  const accelerationScore = Math.round(
    Math.max(0, Math.min(1, acceleration / 20)) * 4,
  );

  // v3: Event Ratio 3 分（异常上涨过滤：>3 直接归 0 分，即"事件脉冲不给动量分"）
  const evt = eventRatio(bars, 21);
  let eventScore = 3;
  if (evt != null && evt > 3) eventScore = 0;
  else if (evt != null && evt > 2) eventScore = 1;

  return {
    score: weightedRpsScore + accelerationScore + eventScore,
    weightedRps: Math.round(weightedRps),
    rps21: Math.round(rps21),
    rps63: Math.round(rps63),
    rps252: Math.round(rps252),
    acceleration: Math.round(acceleration),
    eventRatio: evt != null ? Number(evt.toFixed(2)) : null,
    weightedRpsScore,
    accelerationScore,
    eventScore,
  };
}

// ──────────────── Trend Structure 10 ────────────────

export function computeTrend(bars: DailyBar[]): TrendBreakdown {
  const closes = bars.map((bar) => bar.close);
  const close = closes[closes.length - 1];
  const ma20 = simpleMovingAverage(closes, 20);
  const ma50 = simpleMovingAverage(closes, 50);
  const ma200 = simpleMovingAverage(closes, 200);
  const high52w = highestHigh(bars, Math.min(252, bars.length));

  const stackedMa =
    ma20 != null && ma50 != null && ma200 != null && close > ma20 && ma20 > ma50 && ma50 > ma200;
  const proximity = high52w != null && high52w > 0 ? close / high52w - 1 : null;

  // v3: Minervini 均线+新高 4 分
  let maHighScore = 0;
  if (stackedMa) maHighScore += 2;
  if (proximity != null && proximity >= -0.15) maHighScore += 2;

  // v3: Up Day Ratio 63D 3 分
  const udr = upDayRatio(bars, 63);
  let upDayScore = 0;
  if (udr != null) {
    if (udr >= 0.6) upDayScore = 3;
    else if (udr >= 0.5) upDayScore = 2;
    else if (udr >= 0.4) upDayScore = 1;
  }

  // v3: Drawdown Recovery 3M 3 分（回撤越小得分越高）
  const dd = maxDrawdownRecent(bars, 63);
  let drawdownScore = 0;
  if (dd != null) {
    const ddAbs = Math.abs(dd);
    if (ddAbs <= 0.08) drawdownScore = 3;
    else if (ddAbs <= 0.15) drawdownScore = 2;
    else if (ddAbs <= 0.25) drawdownScore = 1;
  }

  return {
    score: maHighScore + upDayScore + drawdownScore,
    stackedMa,
    proximityToHigh: proximity,
    upDayRatio63: udr,
    drawdown3m: dd,
    maHighScore,
    upDayScore,
    drawdownScore,
  };
}

// ──────────────── Fundamental Quality 25 ────────────────

const MOAT_FALLBACK_SCORE = 3; // LLM 未打时的中性兜底分

export function computeFundamental(fundamentals?: FundamentalSnapshot): FundamentalBreakdown {
  if (!fundamentals) {
    return {
      score: 0,
      hasData: false,
      vetoed: false,
      epsRevision: null,
      revenueGrowth: null,
      grossMargin: null,
      roic: null,
      growthScore: 0,
      profitScore: 0,
      revisionScore: 0,
      moatScore: 0,
      moatReason: null,
      moatSource: "fallback",
    };
  }

  const eps = fundamentals.epsRevisionRate ?? null;
  const rev = fundamentals.revenueGrowth ?? null;
  const gm = fundamentals.grossMargin ?? null;
  const roic = fundamentals.roic ?? null;

  // v3 一票否决：EPS Revision < -10% → 基本面归 0
  if (eps != null && eps < -0.1) {
    return {
      score: 0,
      hasData: true,
      vetoed: true,
      epsRevision: eps,
      revenueGrowth: rev,
      grossMargin: gm,
      roic,
      growthScore: 0,
      profitScore: 0,
      revisionScore: 0,
      moatScore: 0,
      moatReason: null,
      moatSource: "fallback",
    };
  }

  // v3: Growth 8 分（NTM Rev YoY 大 TAM 赛道）
  let growthScore = 0;
  if (rev != null) {
    if (rev >= 0.3) growthScore = 8;
    else if (rev >= 0.2) growthScore = 6;
    else if (rev >= 0.1) growthScore = 4;
    else if (rev >= 0.05) growthScore = 2;
  }

  // v3: Profitability 7 分（GM + FCF Margin + ROIC）
  // 免费源 FCF Margin 拿不稳定 → 用 GM(4) + ROIC(3) 覆盖 7 分
  let profitScore = 0;
  if (gm != null) {
    if (gm >= 0.5) profitScore += 4;
    else if (gm >= 0.35) profitScore += 3;
    else if (gm >= 0.2) profitScore += 2;
  }
  if (roic != null) {
    if (roic >= 0.15) profitScore += 3;
    else if (roic >= 0.08) profitScore += 2;
    else if (roic > 0) profitScore += 1;
  }
  profitScore = Math.min(profitScore, 7);

  // v3: Revisions 5 分
  let revisionScore = 0;
  if (eps != null) {
    if (eps > 0.2) revisionScore = 5;
    else if (eps > 0.1) revisionScore = 4;
    else if (eps > 0) revisionScore = 2;
  }

  // v3 Wave 3: Moat 5 分 · LLM 已打则取 1-5，未打则兜底 3
  const llmMoat = fundamentals.moatScore;
  const moatScore =
    typeof llmMoat === "number" && llmMoat >= 1 && llmMoat <= 5
      ? llmMoat
      : MOAT_FALLBACK_SCORE;
  const moatSource: "llm" | "fallback" =
    typeof llmMoat === "number" && llmMoat >= 1 && llmMoat <= 5 ? "llm" : "fallback";

  return {
    score: growthScore + profitScore + revisionScore + moatScore,
    hasData: true,
    vetoed: false,
    epsRevision: eps,
    revenueGrowth: rev,
    grossMargin: gm,
    roic,
    growthScore,
    profitScore,
    revisionScore,
    moatScore,
    moatReason: fundamentals.moatReason ?? null,
    moatSource,
  };
}

// ──────────────── Stock Quality Orchestrator（返回 3 大项 + Total 50） ────────────────

export type StockQualityBreakdown = {
  total: number; // 0~50
  momentum: MomentumBreakdown;
  trend: TrendBreakdown;
  fundamental: FundamentalBreakdown;
};

type StockCandidate = {
  bars: DailyBar[];
  fundamentals?: FundamentalSnapshot;
};

export function scoreStockQuality(
  candidates: (StockCandidate & { symbol: string })[],
): Map<string, StockQualityBreakdown> {
  const returns21 = candidates.map((c) => percentChange(c.bars.map((b) => b.close), 21) ?? 0);
  const returns63 = candidates.map((c) => percentChange(c.bars.map((b) => b.close), 63) ?? 0);
  const returns252 = candidates.map((c) => percentChange(c.bars.map((b) => b.close), 252) ?? 0);

  const map = new Map<string, StockQualityBreakdown>();
  candidates.forEach((c, i) => {
    const rps21 = percentileRank(returns21[i], returns21);
    const rps63 = percentileRank(returns63[i], returns63);
    const rps252 = percentileRank(returns252[i], returns252);
    const momentum = computeMomentum(c.bars, rps21, rps63, rps252);
    const trend = computeTrend(c.bars);
    const fundamental = computeFundamental(c.fundamentals);
    map.set(c.symbol, {
      total: momentum.score + trend.score + fundamental.score,
      momentum,
      trend,
      fundamental,
    });
  });
  return map;
}
