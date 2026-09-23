import type { EntryQuality } from "@/lib/signals/assessment";
import type { GexSnapshotItem } from "@/lib/discord/gexCopy";

export type Regime =
  | "Risk-On"
  | "Risk-Off"
  | "Rotation"
  | "Transition"
  | "Neutral"
  | "Unknown";
export type ReviewTf = "2h" | "4h";
export type Metric = {
  symbol: string;
  today: number | null;
  yesterday: number | null;
  change: number | null;
};
export type SectorStrength = {
  symbol: string;
  name: string;
  group: "sector" | "industry";
  rps: number | null;
  d1: number | null;
  d5: number | null;
  d20: number | null;
  return20: number | null;
  change: number | null;
};
export type MarketContext = {
  regime: Regime;
  date: string;
  engine?: import("./engine").MarketEngine;
  macro?: import("./macro").MacroEnvironment;
};
export type ReviewMarket = {
  engine?: import("./engine").MarketEngine;
  macro?: import("./macro").MacroEnvironment;
  regime: Regime;
  summary: string;
  metrics: Metric[];
  breadth: {
    today: number | null;
    yesterday: number | null;
    valid: number;
    total: number;
    universe: string;
    membershipAsOf: string | null;
  };
  strongSectors: {
    today: number | null;
    yesterday: number | null;
    total: number;
  };
};
export type OptionsRow = {
  symbol: string;
  today: GexSnapshotItem | null;
  previous: GexSnapshotItem | null;
  dte: string | null;
  comparable: boolean;
  changes: string[];
  meta?: import("@/lib/options/structure").OptionsMeta;
  previousMeta?: import("@/lib/options/structure").OptionsMeta;
  structure?: import("@/lib/options/structure").OptionsStructure;
  shifts?: import("./options").StructureShift[];
  comparison?: import("./options").OptionsComparison;
};
export type Outcome = {
  date: string | null;
  value: number | null;
  status: "ready" | "pending" | "missing";
};
export type JournalSignal = {
  id: string;
  symbol: string;
  tf: ReviewTf;
  date: string;
  signalTime: number;
  capturedAt: string;
  price: number;
  quality: EntryQuality;
  sector: string | null;
  context: MarketContext | null;
  optionsContext?: import("@/lib/options/signalContext").SignalOptionsContext;
  source: "live" | "replay";
  outcomes: { t1: Outcome; t3: Outcome; t5: Outcome };
  excursions: { date: string; mfe: number | null; mae: number | null }[];
};
export type AccountPosition = {
  symbol: string;
  weight: number;
  shares: number | null;
  mark: number | null;
  entryDate: string | null;
};
export type ReviewAccount = {
  tf: ReviewTf;
  asOf: string | null;
  computedAt: string | null;
  equity: number | null;
  daily: number | null;
  monthly: number | null;
  holdings: number | null;
  cashPct: number | null;
  maxWeight: number | null;
  positions: AccountPosition[];
  traded: string[];
  curve: { date: string; equity: number }[];
  attribution: { symbol: string; contribution: number }[];
  residual: number | null;
  note: string;
};
export type DailyReview = {
  version: 1;
  date: string;
  previousDate: string | null;
  builtAt: string;
  market: ReviewMarket;
  publishedMarket?: { builtAt: string; market: ReviewMarket };
  options: OptionsRow[];
  sectors: SectorStrength[];
  signals: JournalSignal[];
  accounts: ReviewAccount[];
  followup?: import("./followup").FollowupSnapshot;
  tomorrow?: import("./tomorrow").TomorrowMap;
  warnings: string[];
};
export type JournalArchive = {
  version: 1;
  asOf: string;
  builtAt: string;
  signals: JournalSignal[];
};
export type ReviewIndex = {
  version: 1;
  latest: string;
  dates: string[];
  updatedAt: string;
};
