import type { LookbackView } from "@/lib/fund/lookbackLogic";
import { cashBookLayout } from "./bookCardLayout";
import { sparklineValues, type CashBookView } from "./bookCopy";
import { renderReportCardPng, reportCardSvg } from "./reportCardImage";

export type CashBookCardInput = CashBookView;

export function cashBookSvg(input: CashBookCardInput): string {
  return reportCardSvg(cashBookLayout(input));
}

export function cashBookFromLookback(view: LookbackView, label: string): CashBookCardInput {
  const s = view.stats;
  return {
    asOf: view.asOf, since: view.since, label, rows: view.rows, equity: view.equity,
    ytdPct: s.ytdPct ?? undefined, ytdYear: s.ytdYear ?? undefined,
    exposurePct: view.exposurePct, dd: s.dd, mar: s.mar, avgHoldings: s.avgHoldings,
    avgExposure: s.avgExposure, winRatePct: s.winRatePct,
    curve: sparklineValues(view.curve.map((p) => p.equity)),
  };
}

export function renderCashBookPng(input: CashBookCardInput): Promise<Buffer> {
  return renderReportCardPng(cashBookLayout(input));
}
