import type { LiveBookCache } from "@/lib/fund/liveBooksLogic";
import type { LookbackView } from "@/lib/fund/lookbackLogic";
import type { RotateCheckpoint } from "@/lib/fund/rotate";
import { TWO_HOUR_VERSION } from "@/lib/backtest/twoHourVersion";
import { createHash } from "node:crypto";

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

export const bookCheckpoint = (): RotateCheckpoint => ({
  version: 1, asOf: "2026-09-08T17:30", cash: 1.08, lastEq: 1.2, seed: 12345,
  slots: { AAPL: { shares: 0.001, cost: 0.1001, eqAtEntry: 1, entryDate: "2026-09-01T13:30", entryPrice: 100, sigType: 1, entryRps: 80 } },
  legs: { AAPL: { lastClose: 120, lastRps: 80, state: { sigType: 1, entryPrice: 100, entryDate: "2026-09-01T13:30",
    stopLevel: 101, trailLevel: 100, highWater: 122, maxPnlPct: 20, initialRisk: 16,
    pendingEntry: 0, pendingEntryAtr: 4, pendingEntryRps: 80, pendingExit: null, entryRps: 80 } } },
  orders: [], decisions: {}, dailyEquity: [{ date: "2026-09-08", v: 1.2 }],
  totals: { entries: 1, rotations: 0, missed: 0, holdingSum: 1, exposureSum: 10, exits: 0, wins: 0, bars: 1 },
});

export const continuousCache = (over: Partial<LiveBookCache> = {}): LiveBookCache => bookCache({
  twoHourVersion: TWO_HOUR_VERSION, accounting: "continuous-v1", epochResetAt: "", poolHistory: [{ id: "baseline", effectiveAt: "", members: ["AAPL", "NVDA"] }],
  poolRevision: createHash("sha256").update(JSON.stringify({ members: ["AAPL", "NVDA"], updatedAt: "" })).digest("hex"),
  books: bookCache().books.map((b) => ({ ...b, view: { ...b.view, rows: b.view.rows.map((r) => ({ ...r, entryDate: "2026-09-01T13:30" })) }, checkpoint: bookCheckpoint() })), ...over,
});
