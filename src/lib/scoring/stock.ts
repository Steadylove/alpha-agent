import type { FundamentalSnapshot } from "@/lib/data-sources/fmp";
import { computeEnvironment } from "@/lib/scoring/environment";
import { computeExecution } from "@/lib/scoring/execution";
import { evaluateKillSwitch } from "@/lib/scoring/killSwitch";
import { latest } from "@/lib/scoring/indicators";
import { scoreStockQuality } from "@/lib/scoring/stockQuality";
import { computePwfv, computeTradingTarget } from "@/lib/scoring/valuation";
import type {
  DailyBar,
  Instrument,
  KillSwitchStatus,
  MarketMetric,
  StockScore,
  WatchlistStatus,
} from "@/lib/types/market";

type ScoreDetails = StockScore["details"];

type StockCandidate = {
  instrument: Instrument;
  bars: DailyBar[];
  fundamentals?: FundamentalSnapshot;
};

const statusForRank = (rank: number, totalScore: number): WatchlistStatus => {
  if (rank <= 2) return "FOCUS";
  if (rank <= 5) return "WATCH";
  if (totalScore >= 70) return "WATCH";
  return "DOWNGRADED";
};

/**
 * v3 白皮书 · 终极决策引擎（Final Compass Score）
 * = 股票质量 50 (Momentum 15 + Trend 10 + Fundamental 25)
 * + 估值赔率 20 (PWFV MoS 10 + 60D RRR 10)
 * + 市场环境 15 (MSS 5 + Breadth 5 + Credit 5)
 * + 执行买点 15 (GBZ 位置 8 + Selling Pressure 4 + 止损比 3)
 *
 * 评分前先跑 Kill Switch，命中任一条 → finalCompassScore=0，killSwitchStatus=BLOCKED。
 */
export function scoreStocks(
  candidates: StockCandidate[],
  marketMetric: MarketMetric | null,
): StockScore[] {
  const qualityMap = scoreStockQuality(
    candidates.map((c) => ({
      symbol: c.instrument.symbol,
      bars: c.bars,
      fundamentals: c.fundamentals,
    })),
  );

  // 市场环境对所有股票相同（全市场共享）
  const env = marketMetric ? computeEnvironment(marketMetric) : null;
  const envTotal = env?.score ?? 0;

  const raw = candidates.map((candidate) => {
    const symbol = candidate.instrument.symbol;
    const kill = evaluateKillSwitch(candidate.bars, candidate.fundamentals);
    const quality = qualityMap.get(symbol);
    const lastBar = latest(candidate.bars);

    if (!quality || !lastBar) {
      const details: ScoreDetails = {};
      return {
        symbol,
        name: candidate.instrument.name,
        sector: candidate.instrument.sector ?? "Unknown",
        finalCompassScore: 0,
        qualityScore: 0,
        momentumScore: 0,
        trendScore: 0,
        fundamentalScore: 0,
        valuationScore: 0,
        environmentScore: envTotal,
        executionScore: 0,
        killSwitchStatus: "BLOCKED" as KillSwitchStatus,
        killSwitchReason: "K 线或质量数据缺失",
        rank: 0,
        status: "DOWNGRADED" as WatchlistStatus,
        details,
      };
    }

    if (!kill.passed) {
      const details: ScoreDetails = { killReason: kill.reason };
      return {
        symbol,
        name: candidate.instrument.name,
        sector: candidate.instrument.sector ?? "Unknown",
        finalCompassScore: 0,
        qualityScore: 0,
        momentumScore: 0,
        trendScore: 0,
        fundamentalScore: 0,
        valuationScore: 0,
        environmentScore: envTotal,
        executionScore: 0,
        killSwitchStatus: "BLOCKED" as KillSwitchStatus,
        killSwitchReason: kill.reason,
        rank: 0,
        status: "DOWNGRADED" as WatchlistStatus,
        details,
      };
    }

    // Valuation 20：只有 Top 段（有 analyst target）能得高分，其余按 fallback 动量兜底
    const closes = candidate.bars.map((b) => b.close);
    const momentum20d =
      closes.length >= 21
        ? (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]
        : null;
    const pwfv = computePwfv(
      lastBar.close,
      candidate.fundamentals?.analystTargetPrice ?? null,
      momentum20d,
    );
    const target = computeTradingTarget(candidate.bars, lastBar.close);
    const valuationScore = pwfv.score + (target?.score ?? 0);

    // Execution 15
    const execution = computeExecution(candidate.bars);

    const finalCompassScore =
      quality.total + valuationScore + envTotal + execution.score;

    const details: ScoreDetails = {
        // Momentum
        rps21: quality.momentum.rps21,
        rps63: quality.momentum.rps63,
        rps252: quality.momentum.rps252,
        weightedRps: quality.momentum.weightedRps,
        acceleration: quality.momentum.acceleration,
        eventRatio: quality.momentum.eventRatio,
        // Trend
        stackedMa: quality.trend.stackedMa,
        proximityToHigh: quality.trend.proximityToHigh,
        upDayRatio63: quality.trend.upDayRatio63,
        drawdown3m: quality.trend.drawdown3m,
        // Fundamental
        hasFundamentalData: quality.fundamental.hasData,
        fundamentalVetoed: quality.fundamental.vetoed,
        epsRevision: quality.fundamental.epsRevision,
        revenueGrowth: quality.fundamental.revenueGrowth,
        grossMargin: quality.fundamental.grossMargin,
        roic: quality.fundamental.roic,
        growthScore: quality.fundamental.growthScore,
        profitScore: quality.fundamental.profitScore,
        revisionScore: quality.fundamental.revisionScore,
        moatScore: quality.fundamental.moatScore,
        moatReason: quality.fundamental.moatReason,
        moatSource: quality.fundamental.moatSource,
        // Valuation
        pwfvBear: pwfv.bear,
        pwfvBase: pwfv.base,
        pwfvBull: pwfv.bull,
        pwfvFair: pwfv.weightedFair,
        pwfvSafetyMargin: pwfv.safetyMargin,
        pwfvSource: pwfv.source,
        pwfvScore: pwfv.score,
        tradingTarget60d: target?.target ?? null,
        tradingStopLoss: target?.stopLoss ?? null,
        rewardRiskRatio: target?.rewardRiskRatio ?? null,
        rrrScore: target?.score ?? 0,
        // Environment
        envMss: env?.mssScore ?? 0,
        envBreadth: env?.breadthScore ?? 0,
        envCredit: env?.creditScore ?? 0,
        // Execution
        gbzZoneScore: execution.gbzZoneScore,
        sellingPressureScore: execution.sellingPressureScore,
        stopRatioScore: execution.stopRatioScore,
        distanceToGbz: execution.distanceToGbz,
        sellingPressure20d: execution.sellingPressure20d,
        stopLossRatio: execution.stopLossRatio,
    };

    return {
      symbol,
      name: candidate.instrument.name,
      sector: candidate.instrument.sector ?? "Unknown",
      finalCompassScore,
      qualityScore: quality.total,
      momentumScore: quality.momentum.score,
      trendScore: quality.trend.score,
      fundamentalScore: quality.fundamental.score,
      valuationScore,
      environmentScore: envTotal,
      executionScore: execution.score,
      killSwitchStatus: "PASSED" as KillSwitchStatus,
      killSwitchReason: null as string | null,
      rank: 0,
      status: "WATCH" as WatchlistStatus,
      details,
    };
  });

  return raw
    .sort((a, b) => b.finalCompassScore - a.finalCompassScore)
    .map((item, index) => {
      const rank = index + 1;
      return {
        ...item,
        rank,
        status:
          item.killSwitchStatus === "BLOCKED"
            ? ("DOWNGRADED" as WatchlistStatus)
            : statusForRank(rank, item.finalCompassScore),
      };
    });
}
