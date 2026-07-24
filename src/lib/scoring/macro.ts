import { percentChange, simpleMovingAverage } from "@/lib/scoring/indicators";
import type { DailyBar, MarketMetric } from "@/lib/types/market";

export function scoreCreditSpreadProxy(hygBars: DailyBar[], tltBars: DailyBar[]): number | null {
  const hyg = percentChange(hygBars.map((bar) => bar.close), 21);
  const tlt = percentChange(tltBars.map((bar) => bar.close), 21);

  if (hyg == null || tlt == null) {
    return null;
  }

  const relative = hyg - tlt;
  // 利差平稳/持续收窄（债市风平浪静）：25 分
  // 利差急剧走阔（债市率先爆发违约预警）：0 分
  if (relative > -0.02) return 25;
  return 0;
}

export function scoreBreadth(stockBars: DailyBar[][]): number | null {
  const eligible = stockBars.filter((bars) => bars.length >= 50);

  if (eligible.length === 0) {
    return null;
  }

  const aboveMa50 = eligible.filter((bars) => {
    const closes = bars.map((bar) => bar.close);
    const ma50 = simpleMovingAverage(closes, 50);
    const lastClose = closes[closes.length - 1];
    return ma50 != null && lastClose > ma50;
  }).length;

  const breadth = aboveMa50 / eligible.length;
  if (breadth > 0.6) return 25;
  if (breadth >= 0.4) return 15;
  return 0;
}

export function scoreMacroSafety(input: {
  date: string;
  hygBars?: DailyBar[];
  tltBars?: DailyBar[];
  stockBars: DailyBar[][];
  skewScore?: number | null;
  pcrScore?: number | null;
}): MarketMetric {
  const creditScore =
    input.hygBars && input.tltBars ? scoreCreditSpreadProxy(input.hygBars, input.tltBars) : null;
  const breadthScore = scoreBreadth(input.stockBars);
  const components = [input.skewScore ?? null, input.pcrScore ?? null, creditScore, breadthScore];
  const available = components.filter((score): score is number => score != null);
  const total = available.reduce((sum, score) => sum + score, 0);
  const mss = available.length === 0 ? 0 : Math.round((total / (available.length * 25)) * 100);

  return {
    date: input.date,
    mss,
    skewScore: input.skewScore ?? null,
    pcrScore: input.pcrScore ?? null,
    creditScore,
    breadthScore,
    confidence: available.length / components.length,
    details: {
      mode: "public-data-mvp",
      missingSkew: input.skewScore == null,
      missingPcr: input.pcrScore == null,
    },
  };
}
