import "dotenv/config";

import {
  CSV_1H_DIR,
  CSV_2H_DIR,
  listCsvTickers,
  readCsvPanel,
  writeCsvPanel,
} from "@/lib/backtest/csvPanel";
import type { PanelBars } from "@/lib/backtest/panel";
import { SMALL_FUND_EXCLUDED, SMALL_FUND_UNIVERSE } from "@/lib/backtest/smallFundUniverse";
import { aggregateTo2H, barTimeISO, type IntradayBar } from "@/lib/data-sources/yahooIntraday";

/**
 * Small Fund 2H：由本地 1H 面板聚合，不再单独抓 Alpaca。
 *
 *   npm run smallfund:fetch-1h   # 先把 1H 拉到位
 *   npm run smallfund:fetch-2h
 *
 * 从本地读而不是重抓：2H 的数据源本来就是 1H，重抓一遍要多花两小时且照样挨限流；
 * 更要紧的是，只有共用同一份 1H 才能保证两个周期的历史起点一致——2H 此前起点是
 * 2021-01，窗口起点处 Vegas 676 根慢线只播种了约 250 根，`vegasOk` 恒为 0，
 * 策略被迫空仓穿过 2022 熊市（4H 踩过同一个坑，见 docs/spec-conformance.md）。
 */

const MIN_BARS = 253;

type Outcome = { ticker: string; bars?: number; first?: string; reason?: string };

/** CSV 里的 date 是 `barTimeISO` 写出的 UTC 分钟串，没带时区后缀。 */
function toIntradayBars(panel: PanelBars): IntradayBar[] {
  // `PanelBars` 的 open/volume 对早期回填的标的可以是 null，但 CSV 这条路径必然写全。
  const { open, volume } = panel;
  if (!open || !volume) throw new Error("1H 面板缺 open 或 volume 列");

  const bars: IntradayBar[] = [];
  for (let i = 0; i < panel.dates.length; i += 1) {
    const ms = Date.parse(`${panel.dates[i]}:00Z`);
    if (!Number.isFinite(ms)) continue;
    bars.push({
      timestamp: Math.floor(ms / 1000),
      open: open[i],
      high: panel.high[i],
      low: panel.low[i],
      close: panel.close[i],
      volume: volume[i],
    });
  }
  return bars;
}

function buildOne(ticker: string): Outcome {
  const oneHour = readCsvPanel(CSV_1H_DIR, ticker);
  if (!oneHour) return { ticker, reason: "本地无 1H 面板，先跑 smallfund:fetch-1h" };

  try {
    const two = aggregateTo2H(toIntradayBars(oneHour));
    if (two.length < MIN_BARS) return { ticker, reason: `样本不足 ${two.length} 根` };

    writeCsvPanel(
      CSV_2H_DIR,
      ticker,
      two.map((b) => ({
        date: barTimeISO(b.timestamp),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
    );
    return { ticker, bars: two.length, first: barTimeISO(two[0].timestamp) };
  } catch (error) {
    return { ticker, reason: error instanceof Error ? error.message : "聚合失败" };
  }
}

function main() {
  console.log(`Small Fund 2H  由本地 1H 聚合  ${SMALL_FUND_UNIVERSE.length} 只`);
  for (const { symbol, reason } of SMALL_FUND_EXCLUDED) {
    console.log(`  剔除 ${symbol}  ${reason}`);
  }
  console.log(`输入 ${CSV_1H_DIR}\n输出 ${CSV_2H_DIR}\n`);

  const ok: Outcome[] = [];
  const failed: Outcome[] = [];
  for (const ticker of SMALL_FUND_UNIVERSE) {
    const r = buildOne(ticker);
    if (r.bars) ok.push(r);
    else failed.push(r);
  }

  console.log(`拿到 ${ok.length} 只  目录内 ${listCsvTickers(CSV_2H_DIR).length} 个文件`);

  // 起点分布是这次改动要盯的指标：全是 2021 说明 1H 还没补完，聚合出来的 2H 依旧没预热。
  const byYear = new Map<string, number>();
  for (const r of ok) {
    const y = r.first!.slice(0, 4);
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  console.log(
    `起点年份：${[...byYear].sort().map(([y, n]) => `${y}×${n}`).join("  ")}`,
  );

  if (failed.length > 0) {
    console.log(`\n失败 ${failed.length} 只:`);
    for (const f of failed) console.log(`  ${f.ticker.padEnd(8)} ${f.reason}`);
  }
}

main();
