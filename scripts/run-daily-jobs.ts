import "dotenv/config";

import { runMacroPhaseJob } from "@/lib/jobs/macroPhase";
import { runRotationRadarJob } from "@/lib/jobs/rotationRadar";
import { runShortInterestJob } from "@/lib/jobs/shortInterest";
import { runStockPanelJob } from "@/lib/jobs/stockPanel";
import { runFundScoreJob } from "@/lib/jobs/fundScore";
import { runStockValuationJob } from "@/lib/jobs/stockValuation";

/**
 * 按依赖顺序跑完每日量化任务链。
 *
 * 顺序不能改：
 *
 * 1. `macro-phase` 写出 snapshots/mpr.json，后面都读它
 * 2. `short-interest` 必须早于 `stock-valuation`
 * 3. `stock-valuation` 早于 `stock-panel`，面板才能带上当日估值
 *
 * 日线从 VPS CSV 读，结果写回 snapshots/。
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
  { name: "stock-valuation", run: runStockValuationJob },
  { name: "stock-panel", run: runStockPanelJob },
  { name: "fund-score", run: () => runFundScoreJob(), soft: true },
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
