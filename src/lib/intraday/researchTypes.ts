import type { IntradaySignal } from "./protocol";

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Quote = { t: number; bid: number; ask: number; bidSize: number; askSize: number };
export type Profile = "formula-only" | "price-volume" | "strict";
export type FloatObservation = { shares: number; availableAt: number };
export type SymbolData = { symbol: string; bars: Bar[]; daily: Bar[]; floats: FloatObservation[]; splitFactors: Record<string, number> };
export type Funnel = { bars: number; sessionBars: number; warmed: number; dailyReady: number; price: number; gain: number; volume: number; floatKnown: number; float: number; resonance: number; eligible: number; entries: number };
export type ResearchEvent = { id: string; tradeId: string | null; source: "offline" | "tv"; observedAt: number | null; payload: IntradaySignal };
export type ReplayResult = { events: ResearchEvent[]; funnel: Funnel; first: number | null; last: number | null; discontinuities: string[] };
export type Execution = { id: string; tradeId: string; symbol: string; eventId: string; time: number; side: "buy" | "sell"; price: number; qty: number; fee: number; reason: string; precision: "bars" | "quotes" };
export type SimTrade = {
  id: string; symbol: string; kind: string; entryTime: number; exitTime: number | null; entry: number; stop: number; qty: number;
  remaining: number; fees: number; net: number; gross: number; risk: number; r: number | null; mfe: number; mae: number;
  lastPrice: number; markTime: number; status: "closed" | "open"; exitReason: string | null;
};
export type DayResult = { date: string; equity: number; returnPct: number; net: number; entries: number; closed: number; drawdownPct: number };
export type Simulation = {
  label: string; precision: "bars" | "quotes"; initialCash: number; equity: number; net: number; returnPct: number; maxDrawdownPct: number;
  closed: number; open: number; wins: number; winRate: number | null; averageWin: number | null; averageLoss: number | null;
  expectancy: number | null; profitFactor: number | null; consecutiveLosses: number; fees: number;
  trades: SimTrade[]; executions: Execution[]; rejected: Record<string, number>; days: DayResult[]; warnings: string[];
};
export type DataManifest = {
  version: 1; id: string; createdAt: string; from: string; to: string; warmupFrom: string; dailyFrom: string;
  universe: string[]; universeHash: string; sessions: string[]; completed: string[]; failed: Record<string, string>;
  empty: string[]; checksums: Record<string, string>; source: "alpaca-sip"; adjustment: "raw";
};
export type ResearchReport = {
  version: 1; id: string; builtAt: string; source: "offline" | "tv"; profile: Profile; dataId: string;
  from: string; to: string; sessions: string[]; universeCount: number; completed: number; failed: Record<string, string>;
  empty: string[]; barCount: number; symbolDays: number; missingSymbolDays: number; floatCoverage: number; warmupInsufficient: number;
  funnel: Funnel; signalCount: number; events: ResearchEvent[]; scenarios: Simulation[];
  warnings: string[]; sourceHash: string; universeHash: string; parameters: Record<string, number | string | boolean>;
  diagnostics: { symbol: string; bars: number; sessionDays: number; signals: number; issue: string | null }[];
};
export type ResearchIndex = { version: 1; updatedAt: string; latest: string; runs: { id: string; builtAt: string; profile: Profile; source: "offline" | "tv"; from: string; to: string; symbols: number; signals: number; precision: string }[] };
