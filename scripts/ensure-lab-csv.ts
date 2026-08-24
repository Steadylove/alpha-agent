import { existsSync, readdirSync } from "node:fs";

import { CSV_PANEL_DIR } from "@/lib/backtest/csvPanel";
import { SPY_CSV_DIR } from "@/lib/backtest/spyCurve";

/**
 * 构建时确认 Small Fund / 标普 CSV 在仓库里。
 * Vercel 运行时只读，缺文件不能再拉 Yahoo，空池会上线。
 */

function countCsv(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".csv")).length;
}

const funds = countCsv(CSV_PANEL_DIR);
const spy = countCsv(SPY_CSV_DIR);

if (funds === 0 || spy === 0) {
  const hint =
    "本地先跑 npm run smallfund:fetch，并保证 data/benchmarks/SPY.csv 存在（跑一次 /lab 会自动拉）。";
  if (process.env.VERCEL) {
    console.error(
      `[lab-csv] 缺失：smallfund=${funds}  spy=${spy}。${hint} 这些文件要进 git，构建才会打进函数包。`,
    );
    process.exit(1);
  }
  console.log(`[lab-csv] smallfund=${funds} spy=${spy}，跳过（${hint}）`);
  process.exit(0);
}

console.log(`[lab-csv] smallfund ${funds} 只 · SPY 已就绪`);
