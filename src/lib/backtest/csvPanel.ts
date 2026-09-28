/**
 * CSV 面板的读写。与 v8 二进制快照产出同一个 `PanelBars`，
 * 下游 `prepareUniverse` 使用统一的数据结构。
 *
 * 按标的分文件，便于核对、续采与单只更新，不依赖 Node 序列化版本。
 * CSV 读取时统一转换为 Float32Array，保持现有回测面板的数值精度。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { csvDir } from "./marketStore";
import type { PanelBars } from "./panel";

export const CSV_PANEL_DIR = csvDir("1d");
export const CSV_4H_DIR = csvDir("4h");
export const CSV_2H_DIR = csvDir("2h");
export const CSV_1H_DIR = csvDir("1h");

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
export function parseCsvText(ticker: string, text: string): PanelBars | null {
  const rows = text.split("\n");
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

export function readCsvPanel(dir: string, ticker: string): PanelBars | null {
  const file = filePathOf(dir, ticker);
  if (!existsSync(file)) return null;
  return parseCsvText(ticker, readFileSync(file, "utf8"));
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
