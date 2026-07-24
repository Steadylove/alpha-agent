export type InstrumentType = "STOCK" | "ETF" | "INDEX";

export type WatchlistStatus = "FOCUS" | "NEW" | "WATCH" | "DOWNGRADED";

export type DailyBar = {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
};

export type Instrument = {
  symbol: string;
  name: string;
  type: InstrumentType;
  sector?: string;
  industry?: string;
  exchange?: string;
};

export type SectorScore = {
  symbol: string;
  name: string;
  rs21: number;
  rs63: number;
  score: number;
  rank: number;
};

export type StockScore = {
  symbol: string;
  name: string;
  sector: string;
  totalScore: number;
  rpsScore: number;
  trendScore: number;
  sectorScore: number;
  fundamentalScore: number;
  accumulationScore: number;
  rank: number;
  status: WatchlistStatus;
  details: Record<string, number | string | boolean | null>;
};

export type MarketMetric = {
  date: string;
  mss: number;
  skewScore: number | null;
  pcrScore: number | null;
  creditScore: number | null;
  breadthScore: number | null;
  confidence: number;
  details: Record<string, number | string | boolean | null>;
};

export type WatchlistChange = {
  symbol: string;
  previous: WatchlistStatus | null;
  current: WatchlistStatus;
  reason: string;
};

export type DailyReportInput = {
  date: string;
  marketMetric: MarketMetric;
  sectorScores: SectorScore[];
  stockScores: StockScore[];
  watchlistChanges: WatchlistChange[];
  newsItems: NewsItem[];
  insights?: ReportInsights | null;
};

export type ReportInsights = {
  marketNarrative: string;
  themeChain: string[];
  beneficiarySectors: string[];
};

export type DailyReport = {
  date: string;
  title: string;
  summary: string;
  body: string;
  version: string;
};

export type NewsItem = {
  externalId: string;
  date: string;
  source: string;
  category: string;
  headline: string;
  summary: string | null;
  url: string;
  imageUrl: string | null;
  relatedSymbols: string[];
  publishedAt: string;
};
