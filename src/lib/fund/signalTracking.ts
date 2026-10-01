import type { RotationTradeState } from "@/lib/scoring/rotationTrade";
import type { BacktestConfig } from "@/lib/backtest/engine";

export type SignalExecutionReason = "accepted" | "cash" | "pool" | "rps" | "eligibility" | "window" | "allocation" | "holding" | "legacy" | "stop" | "target" | "rsWeak" | "veto" | "rotate" | "missing_quote" | "delayed_quote";
export type SignalExecutionEvent = {
  id: string;
  signalId: string;
  symbol: string;
  type: "buy" | "sell" | "account_exit";
  /** CSV UTC bar start; signalTime estimates the close using standard RTH hours. */
  signalDate: string;
  signalTime: string;
  signalTimeEstimated: true;
  entrySignalDate: string | null;
  signalPrice: number;
  kind: 1 | 2;
  status: "pending" | "bought" | "skipped" | "exited" | "observed";
  reason: SignalExecutionReason;
  fillDate?: string;
  fillPrice?: number;
  rps?: number;
};
export type TrackedSignalState = {
  state: RotationTradeState;
  signalId: string | null;
  signalDate: string | null;
  /** Last bar actually consumed for this symbol, not the portfolio's global cutoff. */
  lastProcessedDate?: string;
};
export type SignalTracking = {
  version: 1;
  activatedAt: string;
  asOf: string;
  parameters: Pick<BacktestConfig, "timeframe" | "stopMult" | "trailMult" | "takeProfitR" | "useBuy1" | "useBuy2" | "requireRsi" | "minRsi" | "requireVegas" | "breakevenPct" | "trailTightenPnl"> & { entryAtDayCloseOnly: boolean };
  states: Record<string, TrackedSignalState>;
  accounts: Record<string, { signalId: string | null; legacy: boolean }>;
  events: SignalExecutionEvent[];
  migration: { at: string; positions: { symbol: string; entryDate: string; entryPrice: number; reason: "legacy" }[]; pending: string[] };
};

export function signalParameters(config: BacktestConfig, entryAtDayCloseOnly = false): SignalTracking["parameters"] {
  const { timeframe, stopMult, trailMult, takeProfitR, useBuy1, useBuy2, requireRsi, minRsi, requireVegas, breakevenPct, trailTightenPnl } = config;
  return { timeframe, stopMult, trailMult, takeProfitR, useBuy1, useBuy2, requireRsi, minRsi, requireVegas, breakevenPct, trailTightenPnl, entryAtDayCloseOnly };
}

export function localSignalId(tf: string, symbol: string, date: string, kind: 1 | 2): string {
  return `local:${tf}:${symbol}:${date}:${kind}`;
}

/** Standard RTH bar close, capped at 16:00 New York for the short final bar. */
export function localSignalTime(date: string, tf: string): string {
  const start = Date.parse(`${date.replace(/Z$/, "")}Z`);
  const hours = tf === "2h" ? 2 : tf === "4h" ? 4 : tf === "1h" ? 1 : 24;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(start);
  const minute = Number(parts.find(p => p.type === "hour")?.value) * 60 + Number(parts.find(p => p.type === "minute")?.value);
  const duration = minute >= 570 && minute < 960 ? Math.min(hours * 60, 960 - minute) : hours * 60;
  return new Date(start + duration * 60_000).toISOString();
}
