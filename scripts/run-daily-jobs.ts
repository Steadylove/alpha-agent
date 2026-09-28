import "./load-env";

import { runMacroPhaseJob } from "@/lib/jobs/macroPhase";
import { runOpportunityJob } from "@/lib/jobs/opportunity";

/**
 * 按依赖顺序跑完每日量化任务链。
 *
 * `macro-phase` 写出 snapshots/mpr.json；每日复盘由收盘链在账本更新后生成。
 * 日线从 VPS CSV 读，结果写回 snapshots/。
 */

type Step = {
  name: string;
  run: () => Promise<unknown>;
  /**
   * 失败是否允许继续。
   *
   * 机会快照失败不应阻断后续独立的账本与复盘任务。
   */
  soft?: boolean;
};

const STEPS: Step[] = [
  { name: "macro-phase", run: runMacroPhaseJob },
  { name: "opportunity", run: runOpportunityJob, soft: true },
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
