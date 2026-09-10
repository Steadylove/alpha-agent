/**
 * 已确认属于同一证券的代码变更。只转换行情请求，池、CSV 和账本继续使用传入代码。
 * 两次变更均保持 CUSIP 不变；不要把退市、并购或相似名称自动当作同一证券。
 */
const MARKET_SYMBOL_ALIASES: Readonly<Record<string, string>> = {
  // 2026-01-14：https://www.marsh.com/en/corp/about/news/marsh-mclennan-to-change-nyse-symbol-to-mrsh.html
  MMC: "MRSH",
  // 2026-04-17：https://www.everpuredata.com/company/newsroom/press-releases/everpure-to-change-ticker-symbol.html
  PSTG: "P",
};

export function marketDataSymbol(symbol: string): string {
  return MARKET_SYMBOL_ALIASES[symbol.toUpperCase()] ?? symbol;
}
