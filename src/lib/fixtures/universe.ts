import type { Instrument } from "@/lib/types/market";

export const sectorEtfs: Instrument[] = [
  { symbol: "XLK", name: "Technology Select Sector SPDR", type: "ETF", sector: "Technology" },
  { symbol: "XLF", name: "Financial Select Sector SPDR", type: "ETF", sector: "Financials" },
  { symbol: "XLE", name: "Energy Select Sector SPDR", type: "ETF", sector: "Energy" },
  { symbol: "XLV", name: "Health Care Select Sector SPDR", type: "ETF", sector: "Health Care" },
  { symbol: "XLI", name: "Industrial Select Sector SPDR", type: "ETF", sector: "Industrials" },
  { symbol: "XLY", name: "Consumer Discretionary Select Sector SPDR", type: "ETF", sector: "Consumer Discretionary" },
  { symbol: "XLP", name: "Consumer Staples Select Sector SPDR", type: "ETF", sector: "Consumer Staples" },
  { symbol: "XLU", name: "Utilities Select Sector SPDR", type: "ETF", sector: "Utilities" },
  { symbol: "XLB", name: "Materials Select Sector SPDR", type: "ETF", sector: "Materials" },
  { symbol: "XLRE", name: "Real Estate Select Sector SPDR", type: "ETF", sector: "Real Estate" },
  { symbol: "XLC", name: "Communication Services Select Sector SPDR", type: "ETF", sector: "Communication Services" },
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", type: "ETF", sector: "Benchmark" },
  { symbol: "HYG", name: "iShares iBoxx High Yield Corporate Bond ETF", type: "ETF", sector: "Credit" },
  { symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", type: "ETF", sector: "Credit" },
];

export const stockUniverse: Instrument[] = [
  { symbol: "NVDA", name: "NVIDIA Corp", type: "STOCK", sector: "Technology", industry: "Semiconductors" },
  { symbol: "MSFT", name: "Microsoft Corp", type: "STOCK", sector: "Technology", industry: "Software" },
  { symbol: "AAPL", name: "Apple Inc", type: "STOCK", sector: "Technology", industry: "Consumer Electronics" },
  { symbol: "AVGO", name: "Broadcom Inc", type: "STOCK", sector: "Technology", industry: "Semiconductors" },
  { symbol: "ANET", name: "Arista Networks Inc", type: "STOCK", sector: "Technology", industry: "Networking" },
  { symbol: "MU", name: "Micron Technology Inc", type: "STOCK", sector: "Technology", industry: "Memory" },
  { symbol: "GEV", name: "GE Vernova Inc", type: "STOCK", sector: "Industrials", industry: "Electrical Equipment" },
  { symbol: "META", name: "Meta Platforms Inc", type: "STOCK", sector: "Communication Services", industry: "Internet Content" },
  { symbol: "GOOGL", name: "Alphabet Inc", type: "STOCK", sector: "Communication Services", industry: "Internet Content" },
  { symbol: "AMZN", name: "Amazon.com Inc", type: "STOCK", sector: "Consumer Discretionary", industry: "Internet Retail" },
  { symbol: "TSLA", name: "Tesla Inc", type: "STOCK", sector: "Consumer Discretionary", industry: "Automobiles" },
  { symbol: "PLTR", name: "Palantir Technologies Inc", type: "STOCK", sector: "Technology", industry: "Software" },
  { symbol: "AMD", name: "Advanced Micro Devices Inc", type: "STOCK", sector: "Technology", industry: "Semiconductors" },
  { symbol: "SMCI", name: "Super Micro Computer Inc", type: "STOCK", sector: "Technology", industry: "Hardware" },
  { symbol: "CRWD", name: "CrowdStrike Holdings Inc", type: "STOCK", sector: "Technology", industry: "Cybersecurity" },
];

export const defaultUniverse = [...sectorEtfs, ...stockUniverse];
