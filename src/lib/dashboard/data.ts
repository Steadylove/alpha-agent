import { demoReport, demoReportInput } from "@/lib/fixtures/demo";
import { hasDatabase } from "@/lib/db/remote";
import type {
  DailyReport,
  KillSwitchStatus,
  MarketMetric,
  SectorScore,
  StockScore,
} from "@/lib/types/market";

export type DashboardData = {
  report: DailyReport;
  marketMetric: MarketMetric | null;
  sectors: SectorScore[];
  stocks: StockScore[];
  killSwitchSummary: {
    total: number;
    blocked: StockScore[];
  };
  jobs: Array<{
    id: string;
    name: string;
    status: string;
    startedAt: string;
    durationMs: number;
    error: string | null;
  }>;
};

export async function getDashboardData(): Promise<DashboardData> {
  if (!hasDatabase()) {
    return {
      report: demoReport,
      marketMetric: demoReportInput.marketMetric,
      sectors: demoReportInput.sectorScores,
      stocks: demoReportInput.stockScores,
      killSwitchSummary: { total: demoReportInput.stockScores.length, blocked: [] },
      jobs: [],
    };
  }

  const { getPrisma } = await import("@/lib/db/prisma");
  const prisma = getPrisma();
  const latestScoreDate = await prisma.stockScore.findFirst({
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const [reportRow, marketMetricRow, sectorRows, stockRows, jobRows, killTotalCount, killBlockedRows] =
    await Promise.all([
      prisma.report.findFirst({ orderBy: { date: "desc" } }),
      prisma.marketMetric.findFirst({ orderBy: { date: "desc" } }),
      prisma.sectorScore.findMany({ orderBy: [{ date: "desc" }, { rank: "asc" }], take: 11 }),
      prisma.stockScore.findMany({ orderBy: [{ date: "desc" }, { rank: "asc" }], take: 20 }),
      prisma.jobRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
      latestScoreDate
        ? prisma.stockScore.count({ where: { date: latestScoreDate.date } })
        : 0,
      latestScoreDate
        ? prisma.stockScore.findMany({
            where: { date: latestScoreDate.date, killSwitchStatus: "BLOCKED" },
            orderBy: { symbol: "asc" },
          })
        : [],
    ]);

  return {
    report: reportRow
      ? {
          date: reportRow.date.toISOString().slice(0, 10),
          title: reportRow.title,
          summary: reportRow.summary,
          body: reportRow.body,
          version: reportRow.version,
        }
      : demoReport,
    marketMetric: marketMetricRow
      ? {
          date: marketMetricRow.date.toISOString().slice(0, 10),
          mss: marketMetricRow.mss,
          skewScore: marketMetricRow.skewScore,
          pcrScore: marketMetricRow.pcrScore,
          creditScore: marketMetricRow.creditScore,
          breadthScore: marketMetricRow.breadthScore,
          confidence: marketMetricRow.confidence,
          details: marketMetricRow.details as Record<string, number | string | boolean | null>,
        }
      : null,
    sectors: sectorRows.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      rs21: row.rs21,
      rs63: row.rs63,
      score: row.score,
      rank: row.rank,
    })),
    stocks: stockRows.map((row) => ({
      symbol: row.symbol,
      name: row.symbol,
      sector: "Unknown",
      finalCompassScore: row.finalCompassScore,
      qualityScore: row.qualityScore,
      momentumScore: row.momentumScore,
      trendScore: row.trendScore,
      fundamentalScore: row.fundamentalScore,
      valuationScore: row.valuationScore,
      environmentScore: row.environmentScore,
      executionScore: row.executionScore,
      killSwitchStatus: row.killSwitchStatus as KillSwitchStatus,
      killSwitchReason: row.killSwitchReason,
      rank: row.rank,
      status: row.status,
      details: row.details as Record<string, number | string | boolean | null>,
    })),
    killSwitchSummary: {
      total: killTotalCount,
      blocked: killBlockedRows.map((row) => ({
        symbol: row.symbol,
        name: row.symbol,
        sector: "Unknown",
        finalCompassScore: row.finalCompassScore,
        qualityScore: row.qualityScore,
        momentumScore: row.momentumScore,
        trendScore: row.trendScore,
        fundamentalScore: row.fundamentalScore,
        valuationScore: row.valuationScore,
        environmentScore: row.environmentScore,
        executionScore: row.executionScore,
        killSwitchStatus: row.killSwitchStatus as KillSwitchStatus,
        killSwitchReason: row.killSwitchReason,
        rank: row.rank,
        status: row.status,
        details: row.details as Record<string, number | string | boolean | null>,
      })),
    },
    jobs: jobRows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      durationMs: row.durationMs,
      error: row.error,
    })),
  };
}
