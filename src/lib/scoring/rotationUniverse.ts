/**
 * 轮动雷达的 40 只标的池。
 *
 * 逐条对应「美股动能满仓轮动雷达」Pine 第 20~65 行的 input.symbol 默认值。
 * 产品文档写的是 100 只，但 Pine 实测跑的是这 40 只，以 Pine 为准。
 */

import type { InstrumentType } from "@/lib/types/market";

export type RotationTarget = { symbol: string; name: string; type: InstrumentType };

export const ROTATION_UNIVERSE: readonly RotationTarget[] = [
  { symbol: "QQQ", name: "Invesco QQQ Trust", type: "ETF" },
  { symbol: "AAPL", name: "Apple Inc.", type: "STOCK" },
  { symbol: "NVDA", name: "NVIDIA Corporation", type: "STOCK" },
  { symbol: "MSFT", name: "Microsoft Corporation", type: "STOCK" },
  { symbol: "META", name: "Meta Platforms, Inc.", type: "STOCK" },
  { symbol: "AMZN", name: "Amazon.com, Inc.", type: "STOCK" },
  { symbol: "GOOG", name: "Alphabet Inc.", type: "STOCK" },
  { symbol: "AVGO", name: "Broadcom Inc.", type: "STOCK" },
  { symbol: "RKLB", name: "Rocket Lab Corporation", type: "STOCK" },
  { symbol: "IONQ", name: "IonQ, Inc.", type: "STOCK" },
  { symbol: "ORCL", name: "Oracle Corporation", type: "STOCK" },
  { symbol: "TSLA", name: "Tesla, Inc.", type: "STOCK" },
  { symbol: "NBIS", name: "Nebius Group N.V.", type: "STOCK" },
  { symbol: "MU", name: "Micron Technology, Inc.", type: "STOCK" },
  { symbol: "IREN", name: "IREN Limited", type: "STOCK" },
  { symbol: "INTC", name: "Intel Corporation", type: "STOCK" },
  { symbol: "CAT", name: "Caterpillar Inc.", type: "STOCK" },
  { symbol: "BE", name: "Bloom Energy Corporation", type: "STOCK" },
  { symbol: "AMD", name: "Advanced Micro Devices, Inc.", type: "STOCK" },
  { symbol: "LITE", name: "Lumentum Holdings Inc.", type: "STOCK" },
  { symbol: "TSM", name: "Taiwan Semiconductor Manufacturing", type: "STOCK" },
  { symbol: "GEV", name: "GE Vernova Inc.", type: "STOCK" },
  { symbol: "CRWD", name: "CrowdStrike Holdings, Inc.", type: "STOCK" },
  { symbol: "CRWV", name: "CoreWeave, Inc.", type: "STOCK" },
  { symbol: "DDOG", name: "Datadog, Inc.", type: "STOCK" },
  { symbol: "KO", name: "The Coca-Cola Company", type: "STOCK" },
  { symbol: "MRK", name: "Merck & Co., Inc.", type: "STOCK" },
  { symbol: "IBIT", name: "iShares Bitcoin Trust ETF", type: "ETF" },
  { symbol: "ASTS", name: "AST SpaceMobile, Inc.", type: "STOCK" },
  { symbol: "PLTR", name: "Palantir Technologies Inc.", type: "STOCK" },
  { symbol: "QCOM", name: "QUALCOMM Incorporated", type: "STOCK" },
  { symbol: "VRT", name: "Vertiv Holdings Co", type: "STOCK" },
  { symbol: "WMT", name: "Walmart Inc.", type: "STOCK" },
  { symbol: "GLD", name: "SPDR Gold Shares", type: "ETF" },
  { symbol: "XOM", name: "Exxon Mobil Corporation", type: "STOCK" },
  { symbol: "HOOD", name: "Robinhood Markets, Inc.", type: "STOCK" },
  { symbol: "MRVL", name: "Marvell Technology, Inc.", type: "STOCK" },
  { symbol: "GLW", name: "Corning Incorporated", type: "STOCK" },
  { symbol: "ALAB", name: "Astera Labs, Inc.", type: "STOCK" },
  { symbol: "NEM", name: "Newmont Corporation", type: "STOCK" },
];
