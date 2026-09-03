/**
 * CSV 面板的读写。与数据库路径（load.ts 的 BacktestPanel）产出同一个 `PanelBars`，
 * 下游 `prepareUniverse` 不区分数据来自哪边。
 *
 * 为什么另起一套而不复用 panelCache 的 v8 二进制：那套是为 653 只 × 5000 根
 * （296 万行）设计的，瓶颈在体积；这个池子只有 97 只 × 3300 根，小两个数量级，
 * 换成可读格式的成本可以忽略，而收益是能直接打开核对、不依赖 Node 版本、
 * 数据库额度耗尽时也能跑。
 *
 * 按标的分文件而非单个大表：抓取续跑天然免费（文件在就跳过，不需要 .partial
 * 暂存那一套），单只重抓不牵动其他标的。
 *
 * 精度：CSV 存 Yahoo 原始十进制，读取时解析进 Float32Array——与数据库列的
 * Float32 是同一次舍入，故两条路径的数值必然逐位相同。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PanelBars } from "./panel";

export const CSV_PANEL_DIR = path.join(process.cwd(), "data", "smallfund");
export const CSV_4H_DIR = path.join(process.cwd(), "data", "smallfund4h");
export const CSV_2H_DIR = path.join(process.cwd(), "data", "smallfund2h");
export const CSV_1H_DIR = path.join(process.cwd(), "data", "smallfund1h");

const HEADER = "date,open,high,low,close,volume";

export type CsvBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const filePathOf = (dir: string, ticker: string) => path.join(dir, `${ticker}.csv`);

export const hasCsvPanel = (dir: string, ticker: string) => existsSync(filePathOf(dir, ticker));

export function writeCsvPanel(dir: string, ticker: string, bars: readonly CsvBar[]): void {
  mkdirSync(dir, { recursive: true });
  const lines = [HEADER];
  for (const b of bars) {
    lines.push(`${b.date},${b.open},${b.high},${b.low},${b.close},${b.volume}`);
  }
  writeFileSync(filePathOf(dir, ticker), `${lines.join("\n")}\n`, "utf8");
}

/**
 * 读单只。文件不存在返回 null；缺列或非数值的行整行丢弃——Yahoo 在停牌日会返回
 * null 价格，抓取层已经过滤过一遍，这里是第二道防线，避免 NaN 渗进 Float32Array
 * 之后在 ATR、EMA 里扩散成整条序列不可用。
 */
export function readCsvPanel(dir: string, ticker: string): PanelBars | null {
  const file = filePathOf(dir, ticker);
  if (!existsSync(file)) return null;

  const rows = readFileSync(file, "utf8").split("\n");
  const dates: string[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];

  for (let i = 1; i < rows.length; i += 1) {
    const line = rows[i].trim();
    if (line === "") continue;
    const cells = line.split(",");
    if (cells.length < 6) continue;

    const nums = [cells[1], cells[2], cells[3], cells[4], cells[5]].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;

    dates.push(cells[0]);
    open.push(nums[0]);
    high.push(nums[1]);
    low.push(nums[2]);
    close.push(nums[3]);
    volume.push(nums[4]);
  }

  if (dates.length === 0) return null;

  return {
    ticker,
    dates,
    high: Float32Array.from(high),
    low: Float32Array.from(low),
    close: Float32Array.from(close),
    volume: Float32Array.from(volume),
    open: Float32Array.from(open),
  };
}

/** 按给定清单读取，缺文件的标的静默跳过（抓取阶段已经报告过失败原因）。 */
export function readCsvPanels(dir: string, tickers: readonly string[]): PanelBars[] {
  const out: PanelBars[] = [];
  for (const ticker of tickers) {
    const panel = readCsvPanel(dir, ticker);
    if (panel) out.push(panel);
  }
  return out;
}

/** 目录里实际有哪些标的，用于抓取报告与导入脚本。 */
export function listCsvTickers(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .map((f) => f.slice(0, -4))
    .sort();
}
