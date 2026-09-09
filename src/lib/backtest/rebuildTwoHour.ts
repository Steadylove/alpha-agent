import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { listCsvTickers, readCsvPanel, writeCsvPanel } from "./csvPanel";
import { twoHourBarsFromHourly } from "./twoHourPanel";
import { barTimeISO } from "@/lib/data-sources/yahooIntraday";

/** 从已有 1H 全量重建；全部成功才替换 2H 目录，绝不向旧分桶追加。 */
export function rebuildTwoHourCsv(hourlyDir: string, twoHourDir: string, required: readonly string[] = []) {
  if (path.resolve(hourlyDir) === path.resolve(twoHourDir)) throw new Error("1H 输入与 2H 输出目录不能相同");
  const tickers = [...new Set([...required, ...listCsvTickers(hourlyDir), ...listCsvTickers(twoHourDir)])]
    .filter((t) => t !== "SKHY" && t !== "SPCX").sort();
  if (!tickers.length) throw new Error("没有可用 1H 文件，请先同步已有行情");
  const stage = `${twoHourDir}.stage-${randomUUID()}`;
  const backup = `${twoHourDir}.old-${randomUUID()}`;
  mkdirSync(stage, { recursive: true });
  const report: { ticker: string; bars: number; from: string; asOf: string }[] = [];
  const failures: string[] = [];
  try {
    for (const ticker of tickers) {
      try {
        const panel = readCsvPanel(hourlyDir, ticker);
        if (!panel) throw new Error("缺少 1H 文件");
        const bars = twoHourBarsFromHourly(panel).map((b) => ({ ...b, date: barTimeISO(b.timestamp) }));
        writeCsvPanel(stage, ticker, bars);
        report.push({ ticker, bars: bars.length, from: bars[0].date, asOf: bars.at(-1)!.date });
      } catch (error) {
        failures.push(`${ticker}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length) throw new Error(`2H 重建失败，未发布任何新文件：${failures.join("；")}`);
    const hadOld = existsSync(twoHourDir);
    if (hadOld) renameSync(twoHourDir, backup);
    try { renameSync(stage, twoHourDir); }
    catch (error) { if (hadOld) renameSync(backup, twoHourDir); throw error; }
    rmSync(backup, { recursive: true, force: true });
    return report;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
