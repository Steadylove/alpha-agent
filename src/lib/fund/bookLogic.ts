/**
 * 小基金资金账本的纯逻辑。浏览器可以 import 这个文件，磁盘读写在 `book.ts`。
 *
 * 与 `deskLedger`（记人对信号的确认/否决）和 `liveBook`（记股票池加减票）都不同：
 * 这里记的是**真实成交**——买了多少钱、成交价多少、卖了拿回多少。回测推演出的持仓
 * 不写进来，两者必须能对账，混在一起就查不出漏做的那笔。
 */

export type FundExitReason = "stop" | "rotate" | "manual";

export type FundLotExit = {
  date: string;
  price: number;
  /** 卖出实收现金（已扣费）。不由 shares×price 推算，因为费和滑点要如实记。 */
  proceeds: number;
  reason: FundExitReason;
};

export type FundLot = {
  id: string;
  symbol: string;
  /** 信号来自哪个周期，仅备查 */
  timeframe: string;
  sigType: 1 | 2;
  entryDate: string;
  entryPrice: number;
  shares: number;
  /** 买入实付现金（已含费）。同样不由 shares×price 推算。 */
  cost: number;
  /** 开仓时的 RPS，仅备查——置换比的是**当前** RPS，不是这个。 */
  entryRps: number;
  exit?: FundLotExit;
  note?: string;
};

/** 注资为正、提取为负。 */
export type FundCashFlow = { date: string; amount: number; note?: string };

export type FundBook = {
  cashFlows: FundCashFlow[];
  lots: FundLot[];
};

export const EMPTY_BOOK: FundBook = { cashFlows: [], lots: [] };

export const openLots = (book: FundBook): FundLot[] => book.lots.filter((l) => !l.exit);

export const closedLots = (book: FundBook): FundLot[] => book.lots.filter((l) => l.exit);

/**
 * 现金 = 注资 − 买入 + 卖出。
 *
 * 刻意不单独存一个 cash 字段：两处记账迟早对不上，而对不上的账本比没有账本更坏。
 */
export function cashOf(book: FundBook): number {
  let cash = 0;
  for (const f of book.cashFlows) cash += f.amount;
  for (const l of book.lots) {
    cash -= l.cost;
    if (l.exit) cash += l.exit.proceeds;
  }
  return cash;
}

/**
 * 权益 = 现金 + 未平仓市值。
 *
 * 取不到报价的持仓按成本计：宁可让权益显得不动，也不要用一个猜的价去标记它，
 * 那会直接歪掉下一笔的开仓金额。
 */
export function equityOf(book: FundBook, marks: ReadonlyMap<string, number>): number {
  let eq = cashOf(book);
  for (const lot of openLots(book)) {
    const px = marks.get(lot.symbol);
    eq += px != null && px > 0 ? lot.shares * px : lot.cost;
  }
  return eq;
}

export function realizedPnl(book: FundBook): number {
  let pnl = 0;
  for (const lot of closedLots(book)) pnl += lot.exit!.proceeds - lot.cost;
  return pnl;
}

export function lotId(symbol: string, entryDate: string): string {
  return `${symbol}|${entryDate}`;
}
