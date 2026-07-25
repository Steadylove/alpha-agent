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

export type KillSwitchStatus = "PASSED" | "BLOCKED";

export type StockScore = {
  symbol: string;
  name: string;
  sector: string;
  finalCompassScore: number; // 0~100 · v3 终极决策打分
  qualityScore: number; // 0~50
  momentumScore: number; // 0~15
  trendScore: number; // 0~10
  fundamentalScore: number; // 0~25
  valuationScore: number; // 0~20
  environmentScore: number; // 0~15
  executionScore: number; // 0~15
  killSwitchStatus: KillSwitchStatus;
  killSwitchReason: string | null;
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
  finalScore?: number;
};

export type Valuation = {
  bear: number;
  base: number;
  bull: number;
  weightedFair: number;
  safetyMargin: number;
  score: number;
};

export type ExecutionPlan = {
  symbol: string;
  currentPrice: number;
  signalConfidence: number;
  positionSizePercent: number;
  goldenBuyLow: number;
  goldenBuyHigh: number;
  stopLoss: number;
  expectedReturn60d: number;
  expectedVolatility60d: number;
  rewardRiskRatio: number;
  valuation: Valuation;
};

export type DailyReportInput = {
  date: string;
  marketMetric: MarketMetric;
  sectorScores: SectorScore[];
  stockScores: StockScore[];
  watchlistChanges: WatchlistChange[];
  newsItems: NewsItem[];
  insights?: ReportInsights | null;
  execution?: ExecutionPlan | null;
  executions?: ExecutionPlan[];
};

export type ReportInsights = {
  marketNarrative: string;
  themeChain: string[];
  beneficiarySectors: string[];
  sectorHeadlines?: Record<string, string>;
  featuredQuality?: string | null;
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
