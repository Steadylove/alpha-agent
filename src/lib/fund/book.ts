/**
 * 资金账本的磁盘读写。浏览器不能 import 这个文件。
 *
 * 存在 `data/desk/fund-book.json` 并进 git：账本是这套东西里最不能丢的资产，
 * 让它跟着仓库走顺带就有了版本历史，改错了能翻回去。
 *
 * 注意 Vercel 的文件系统只读，所以线上环境不能记账——那边只跑无状态的信号转发。
 * 要把记账搬上去得先换成数据库，`FUND_BOOK_PATH` 留了口子但解决不了持久化。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  cashOf,
  EMPTY_BOOK,
  lotId,
  openLots,
  type FundBook,
  type FundCashFlow,
  type FundExitReason,
  type FundLot,
} from "./bookLogic";

export * from "./bookLogic";

export function fundBookPath(): string {
  return process.env.FUND_BOOK_PATH ?? path.join(process.cwd(), "data", "desk", "fund-book.json");
}

export function readFundBook(): FundBook {
  const file = fundBookPath();
  if (!existsSync(file)) return { ...EMPTY_BOOK };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<FundBook>;
    return {
      cashFlows: Array.isArray(raw.cashFlows) ? raw.cashFlows : [],
      lots: Array.isArray(raw.lots) ? raw.lots : [],
    };
  } catch {
    return { ...EMPTY_BOOK };
  }
}

function writeFundBook(book: FundBook): void {
  const file = fundBookPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(book, null, 2)}\n`);
}

export function recordCashFlow(input: FundCashFlow): FundBook {
  const book = readFundBook();
  book.cashFlows.push({
    date: input.date.slice(0, 10),
    amount: input.amount,
    note: input.note,
  });
  book.cashFlows.sort((a, b) => (a.date < b.date ? -1 : 1));
  writeFundBook(book);
  return book;
}

export function recordBuy(input: {
  symbol: string;
  timeframe: string;
  sigType: 1 | 2;
  date: string;
  price: number;
  /** 实付现金（含费） */
  cost: number;
  rps: number;
  note?: string;
}): FundLot {
  const book = readFundBook();
  const symbol = input.symbol.trim().toUpperCase();
  const date = input.date.slice(0, 10);

  if (openLots(book).some((l) => l.symbol === symbol)) {
    throw new Error(`${symbol} 已有未平仓持仓，先平掉再买`);
  }
  if (input.price <= 0) throw new Error("成交价必须大于 0");
  if (input.cost <= 0) throw new Error("成交金额必须大于 0");
  const cash = cashOf(book);
  if (input.cost > cash + 1e-9) {
    throw new Error(`现金不足：需要 ${input.cost.toFixed(2)}，账上 ${cash.toFixed(2)}`);
  }

  const lot: FundLot = {
    id: lotId(symbol, date),
    symbol,
    timeframe: input.timeframe,
    sigType: input.sigType,
    entryDate: date,
    entryPrice: input.price,
    // 份额按实付金额与成交价推：费用摊进成本，份额仍要真实
    shares: input.cost / input.price,
    cost: input.cost,
    entryRps: input.rps,
    note: input.note,
  };
  book.lots.push(lot);
  writeFundBook(book);
  return lot;
}

export function recordSell(input: {
  symbol: string;
  date: string;
  price: number;
  /** 实收现金（已扣费） */
  proceeds: number;
  reason: FundExitReason;
  note?: string;
}): FundLot {
  const book = readFundBook();
  const symbol = input.symbol.trim().toUpperCase();
  const lot = openLots(book).find((l) => l.symbol === symbol);
  if (!lot) throw new Error(`${symbol} 没有未平仓持仓`);
  if (input.price <= 0) throw new Error("成交价必须大于 0");

  lot.exit = {
    date: input.date.slice(0, 10),
    price: input.price,
    proceeds: input.proceeds,
    reason: input.reason,
  };
  if (input.note) lot.note = input.note;
  writeFundBook(book);
  return lot;
}
