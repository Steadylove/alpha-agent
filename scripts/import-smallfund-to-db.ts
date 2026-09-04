import "dotenv/config";

import {
  CSV_1H_DIR,
  CSV_2H_DIR,
  CSV_4H_DIR,
  CSV_PANEL_DIR,
  listCsvTickers,
  readCsvPanel,
} from "@/lib/backtest/csvPanel";
import { packPanel, packTimedPanel } from "@/lib/backtest/panel";
import { getPrisma } from "@/lib/db/prisma";

/**
 * 把 data/smallfund* CSV 写入数据库。
 *
 * - 日线 → BacktestPanel（已有表，按 ticker upsert）
 * - 4H/2H/1H → BacktestTfPanel（分钟戳，不会塌成同一天）
 *
 * 导入目录里有的票，含 sf-broad 多出来的那批。
 *
 * 用法: npm run smallfund:import
 *       npm run smallfund:import -- --tf 4h
 */

const ALL_TF = ["1d", "4h", "2h", "1h"] as const;
type ImportTf = (typeof ALL_TF)[number];

const DIR: Record<ImportTf, string> = {
  "1d": CSV_PANEL_DIR,
  "4h": CSV_4H_DIR,
  "2h": CSV_2H_DIR,
  "1h": CSV_1H_DIR,
};

function parseTfs(): ImportTf[] {
  const i = process.argv.indexOf("--tf");
  if (i < 0) return [...ALL_TF];
  const raw = process.argv[i + 1];
  if (raw === "1d" || raw === "4h" || raw === "2h" || raw === "1h") return [raw];
  throw new Error(`--tf 只能是 ${ALL_TF.join("/")}`);
}

async function main() {
  const prisma = getPrisma();
  const tfs = parseTfs();

  for (const tf of tfs) {
    const dir = DIR[tf];
    const tickers = listCsvTickers(dir);
    if (tickers.length === 0) {
      console.log(`跳过 ${tf}：${dir} 没有 CSV`);
      continue;
    }
    console.log(`导入 ${tf}  ${tickers.length} 只  ${dir}`);
    let ok = 0;
    for (const ticker of tickers) {
      const panel = readCsvPanel(dir, ticker);
      if (!panel || panel.dates.length === 0) {
        console.log(`  跳过 ${ticker}（空文件）`);
        continue;
      }
      const bars = panel.dates.map((date, i) => ({
        date,
        open: panel.open?.[i] ?? panel.close[i],
        high: panel.high[i],
        low: panel.low[i],
        close: panel.close[i],
        volume: panel.volume?.[i] ?? 0,
      }));

      if (tf === "1d") {
        const packed = packPanel(bars);
        const data = {
          firstDate: packed.firstDate,
          lastDate: packed.lastDate,
          barCount: packed.barCount,
          days: packed.days,
          high: packed.high,
          low: packed.low,
          close: packed.close,
          volume: packed.volume,
          open: packed.open,
        };
        await prisma.backtestPanel.upsert({
          where: { ticker },
          update: data,
          create: { ticker, ...data },
        });
      } else {
        const packed = packTimedPanel(bars);
        const data = {
          firstDate: packed.firstDate,
          lastDate: packed.lastDate,
          barCount: packed.barCount,
          times: packed.times,
          high: packed.high,
          low: packed.low,
          close: packed.close,
          volume: packed.volume,
          open: packed.open,
        };
        await prisma.backtestTfPanel.upsert({
          where: { ticker_timeframe: { ticker, timeframe: tf } },
          update: data,
          create: { ticker, timeframe: tf, ...data },
        });
      }
      ok += 1;
      process.stdout.write(`\r  已写 ${ok}/${tickers.length}  ${ticker.padEnd(8)}`);
    }
    console.log(`\n  ${tf} 完成 ${ok} 只`);
  }

  console.log("之后线上设 SMALLFUND_SOURCE=db（生产默认就是 db）。");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
