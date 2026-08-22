import "dotenv/config";

import { getPrisma } from "@/lib/db/prisma";
import { runMacroPhaseJob } from "@/lib/jobs/macroPhase";
import { runRotationRadarJob } from "@/lib/jobs/rotationRadar";
import { runShortInterestJob } from "@/lib/jobs/shortInterest";
import { runStockPanelJob } from "@/lib/jobs/stockPanel";
import { runStockValuationJob } from "@/lib/jobs/stockValuation";

/**
 * 按依赖顺序跑完每日量化任务链。
 *
 * 顺序不能改：
 *
 * 1. `macro-phase` 产出 MacroPhaseState，后面三个都要读它
 *    （低吸带的 Path 4 冻结、估值的 fsmState/pathId、提前保本的宏观条件）
 * 2. `short-interest` 必须早于 `stock-valuation`，否则轧空档位读到的是上一期
 * 3. `rotation-radar` 与 `stock-panel` 之间无依赖，顺序任意
 *
 * 日线由 workflow 里的三个 backfill 脚本先行补齐，此处只做计算。
 */

type Step = {
  name: string;
  run: () => Promise<unknown>;
  /**
   * 失败是否允许继续。
   *
   * 只有空头持仓是软失败：它依赖 FINRA 与 SEC 两个外部免费接口，双月才换一期，
   * 挂掉时估值会沿用上一期缓存，不该因此拖垮整条链。
   */
  soft?: boolean;
};

const STEPS: Step[] = [
  { name: "macro-phase", run: runMacroPhaseJob },
  { name: "short-interest", run: runShortInterestJob, soft: true },
  { name: "rotation-radar", run: runRotationRadarJob },
  { name: "stock-panel", run: runStockPanelJob },
  { name: "stock-valuation", run: runStockValuationJob },
];

async function main() {
  const failures: string[] = [];

  for (const step of STEPS) {
    const startedAt = Date.now();
    console.log(`\n=== ${step.name} ===`);
    try {
      const result = await step.run();
      console.log(`✓ ${step.name} ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗ ${step.name}: ${message}`);
      if (!step.soft) throw error;
      failures.push(step.name);
    }
  }

  if (failures.length > 0) {
    console.log(`\n软失败（已跳过，不影响后续）: ${failures.join(", ")}`);
  }
  console.log("\n全部完成");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPrisma().$disconnect();
    } catch {
      // 初始化前就失败时 Prisma 还不存在
    }
  });
