import "dotenv/config";

import { CSV_PANEL_DIR, listCsvTickers, readCsvPanel } from "@/lib/backtest/csvPanel";
import { packPanel } from "@/lib/backtest/panel";
import { SMALL_FUND_UNIVERSE } from "@/lib/backtest/smallFundUniverse";
import { getPrisma } from "@/lib/db/prisma";

/**
 * 把 data/smallfund/*.csv 写入 BacktestPanel。额度恢复后跑一次即可切回数据库路径。
 *
 * 不写 IndexMembership：Small Fund 是静态池，load.ts 按 ticker 清单过滤，
 * 成分资格用一段全覆盖区间在内存里合成。
 *
 * 用法: npm run smallfund:import
 */

async function main() {
  const prisma = getPrisma();
  const files = listCsvTickers(CSV_PANEL_DIR);
  const wanted = new Set(SMALL_FUND_UNIVERSE);
  const tickers = files.filter((t) => wanted.has(t));

  if (tickers.length === 0) {
    throw new Error(`没有可导入的 CSV：${CSV_PANEL_DIR}。先跑 npm run smallfund:fetch。`);
  }

  console.log(`导入 ${tickers.length} 只 → BacktestPanel`);

  let ok = 0;
  for (const ticker of tickers) {
    const panel = readCsvPanel(CSV_PANEL_DIR, ticker);
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
    ok += 1;
    process.stdout.write(`\r  已写 ${ok}/${tickers.length}  ${ticker.padEnd(8)}`);
  }

  console.log(`\n完成 ${ok} 只。之后设 SMALLFUND_SOURCE=db 即走数据库。`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
