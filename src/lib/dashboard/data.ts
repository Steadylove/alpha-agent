import { demoReport, demoReportInput } from "@/lib/fixtures/demo";
import type {
  DailyReport,
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
  return {
    report: demoReport,
    marketMetric: demoReportInput.marketMetric,
    sectors: demoReportInput.sectorScores,
    stocks: demoReportInput.stockScores,
    killSwitchSummary: { total: demoReportInput.stockScores.length, blocked: [] },
    jobs: [],
  };
}
