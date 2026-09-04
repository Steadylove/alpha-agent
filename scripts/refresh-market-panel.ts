import "dotenv/config";

process.env.ALLOW_DB = "1";

import { runRefreshMarketPanelJob } from "@/lib/jobs/refreshMarketPanel";

async function main() {
  const result = await runRefreshMarketPanelJob();
  const line = (name: string, s: { tickers: number; updated: number; unchanged: number; failed: number; newest: string | null; failures: string[] }) => {
    console.log(
      `[panel-refresh] ${name} 截至 ${result.until}  ${s.tickers} 只  ` +
        `更新 ${s.updated}  未变 ${s.unchanged}  失败 ${s.failed}  最新 ${s.newest ?? "—"}`,
    );
    if (s.failures.length > 0) console.log(`  失败样例: ${s.failures.join(" | ")}`);
  };
  line("1d", result.daily);
  line("4h", result.tf["4h"]);
  line("2h", result.tf["2h"]);
  if (result.scaleTo) console.log(`[panel-refresh] RPS 标尺到 ${result.scaleTo}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const { getPrisma } = await import("@/lib/db/prisma");
      await getPrisma().$disconnect();
    } catch {
      // 初始化前失败
    }
  });
