import type { LiveBookCache } from "@/lib/fund/liveBooksLogic";
import type { LookbackView } from "@/lib/fund/lookbackLogic";

export const bookView = (over: Partial<LookbackView> = {}): LookbackView => ({
  since: "2026-01-01", asOf: "2026-09-08T17:30", equity: 1.2, pnl: "+20.0%", exposurePct: 10,
  rows: [{ symbol: "AAPL", floatPnlPct: 20, entryPrice: 100, weightPct: 10, rps: 80 }],
  curve: [{ date: "2026-09-08", equity: 1.2, exposurePct: 10, rows: [], buys: ["AAPL"], sells: [], misses: [] }],
  fills: [{ date: "2026-09-08", side: "buy", symbol: "AAPL", price: 100 }], misses: [],
  stats: { cagr: 20, dd: 10, mar: 2, entries: 1, rotations: 0, avgHoldings: 1, avgExposure: 10, tradesPerYear: 2, ytdYear: 2026, ytdPct: 20, winRatePct: null },
  ...over,
});

export const bookCache = (over: Partial<LiveBookCache> = {}): LiveBookCache => ({
  runId: "test-run-1", computedAt: "2026-09-09T00:00:00.000Z", epochFrom: "2026-01-01",
  poolKey: "AAPL,NVDA", slots: 10, marketRevision: "market-1", strategyKey: "strategy-1",
  books: [{ tf: "4h", name: "4 小时", view: bookView() }, { tf: "2h", name: "2 小时", view: bookView() }],
  ...over,
});
