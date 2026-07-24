import type { FundamentalSnapshot } from "@/lib/data-sources/fmp";
import {
  chaikinMoneyFlow,
  highestHigh,
  latest,
  percentChange,
  percentileRank,
  pocketPivot,
  positionScore,
  simpleMovingAverage,
} from "@/lib/scoring/indicators";
import type { DailyBar, Instrument, SectorScore, StockScore, WatchlistStatus } from "@/lib/types/market";

type StockCandidate = {
  instrument: Instrument;
  bars: DailyBar[];
  fundamentals?: FundamentalSnapshot;
};

const scoreTrend = (bars: DailyBar[]): number => {
  const closes = bars.map((bar) => bar.close);
  const close = closes[closes.length - 1];
  const ma20 = simpleMovingAverage(closes, 20);
  const ma50 = simpleMovingAverage(closes, 50);
  const ma200 = simpleMovingAverage(closes, 200);
  const high52w = highestHigh(bars, Math.min(252, bars.length));

  let score = 0;
  if (ma20 != null && ma50 != null && ma200 != null && close > ma20 && ma20 > ma50 && ma50 > ma200) {
    score += 12;
  }
  if (high52w != null && close >= high52w * 0.85) {
    score += 8;
  }
  return score;
};

const scoreFundamentals = (fundamentals?: FundamentalSnapshot): number => {
  if (!fundamentals) {
    return 0;
  }

  // 一票否决：若分析师大幅下调 EPS，该项直接归 0 分
  if (fundamentals.epsRevisionRate != null && fundamentals.epsRevisionRate < -0.1) {
    return 0;
  }

  let score = 0;
  // 分析师预期修正（核心）：过去30天 EPS Revision
  if (fundamentals.epsRevisionRate != null && fundamentals.epsRevisionRate > 0.1) {
    score += 10;
  }
  
  // 远期营收增速：NTM Revenue YoY
  if (fundamentals.revenueGrowth != null && fundamentals.revenueGrowth > 0.2) {
    score += 7;
  }
  
  // 历史盈利与质量：最新 Q 营收增速且毛利率高
  if (fundamentals.revenueGrowth != null && fundamentals.grossMargin != null) {
    if (fundamentals.revenueGrowth > 0.2 && fundamentals.grossMargin > 0.4) {
      score += 8;
    }
  }
  return score;
};

const scoreAccumulation = (bars: DailyBar[]): number => {
  const lastBar = latest(bars);
  if (!lastBar) {
    return 0;
  }

  const pos = positionScore(lastBar);
  // 防派发：若长上影派发明显，该项直接归 0 分
  // closing in bottom 40% of range with high volume is distribution
  if (pos < 0.4) {
    return 0;
  }

  let score = 0;
  // 短期口袋支点或强势企稳
  if (pos >= 0.7 && pocketPivot(bars)) {
    score += 7;
  }

  // 资金净流入
  const cmf = chaikinMoneyFlow(bars, 20);
  if (cmf != null && cmf > 0.05) {
    score += 8;
  }
  return score;
};

const statusForRank = (rank: number, totalScore: number): WatchlistStatus => {
  if (rank <= 2) return "FOCUS";
  if (rank <= 5) return "WATCH";
  if (totalScore >= 70) return "WATCH";
  return "DOWNGRADED";
};

export function scoreStocks(
  candidates: StockCandidate[],
  sectorScores: SectorScore[],
): StockScore[] {
  const returns21 = candidates.map((candidate) =>
    percentChange(candidate.bars.map((bar) => bar.close), 21) ?? 0,
  );
  const returns63 = candidates.map((candidate) =>
    percentChange(candidate.bars.map((bar) => bar.close), 63) ?? 0,
  );
  const returns252 = candidates.map((candidate) =>
    percentChange(candidate.bars.map((bar) => bar.close), 252) ?? 0,
  );
  const topSectors = new Set(sectorScores.slice(0, 3).map((sector) => sector.name));

  const raw = candidates.map((candidate, index) => {
    const rps63 = percentileRank(returns63[index], returns63);
    const rps21 = percentileRank(returns21[index], returns21);
    const rps252 = percentileRank(returns252[index], returns252);
    const weightedRps = 0.5 * rps63 + 0.3 * rps21 + 0.2 * rps252;
    const rpsScore = (weightedRps >= 90 ? 15 : Math.round((weightedRps / 90) * 15)) + (rps21 > rps63 ? 10 : 0);
    const trendScore = scoreTrend(candidate.bars);
    const sectorScore = candidate.instrument.sector && topSectors.has(candidate.instrument.sector) ? 15 : 0;
    const fundamentalScore = scoreFundamentals(candidate.fundamentals);
    const accumulationScore = scoreAccumulation(candidate.bars);
    const totalScore = rpsScore + trendScore + sectorScore + fundamentalScore + accumulationScore;

    return {
      symbol: candidate.instrument.symbol,
      name: candidate.instrument.name,
      sector: candidate.instrument.sector ?? "Unknown",
      totalScore,
      rpsScore,
      trendScore,
      sectorScore,
      fundamentalScore,
      accumulationScore,
      rank: 0,
      status: "WATCH" as WatchlistStatus,
      details: {
        rps21: Math.round(rps21),
        rps63: Math.round(rps63),
        rps252: Math.round(rps252),
        weightedRps: Math.round(weightedRps),
        hasFundamentalData: Boolean(candidate.fundamentals),
      },
    };
  });

  return raw
    .sort((a, b) => b.totalScore - a.totalScore)
    .map((item, index) => {
      const rank = index + 1;
      return {
        ...item,
        rank,
        status: statusForRank(rank, item.totalScore),
      };
    });
}
