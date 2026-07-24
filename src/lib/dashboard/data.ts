import { demoReport, demoReportInput } from "@/lib/fixtures/demo";
import type { DailyReport, SectorScore, StockScore } from "@/lib/types/market";

export type DashboardData = {
  report: DailyReport;
  sectors: SectorScore[];
  stocks: StockScore[];
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
  if (!process.env.DATABASE_URL) {
    return {
      report: demoReport,
      sectors: demoReportInput.sectorScores,
      stocks: demoReportInput.stockScores,
      jobs: [],
    };
  }

  const { getPrisma } = await import("@/lib/db/prisma");
  const prisma = getPrisma();
  const [reportRow, sectorRows, stockRows, jobRows] = await Promise.all([
    prisma.report.findFirst({ orderBy: { date: "desc" } }),
    prisma.sectorScore.findMany({ orderBy: [{ date: "desc" }, { rank: "asc" }], take: 11 }),
    prisma.stockScore.findMany({ orderBy: [{ date: "desc" }, { rank: "asc" }], take: 20 }),
    prisma.jobRun.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
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
      totalScore: row.totalScore,
      rpsScore: row.rpsScore,
      trendScore: row.trendScore,
      sectorScore: row.sectorScore,
      fundamentalScore: row.fundamentalScore,
      accumulationScore: row.accumulationScore,
      rank: row.rank,
      status: row.status,
      details: row.details as Record<string, number | string | boolean | null>,
    })),
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
