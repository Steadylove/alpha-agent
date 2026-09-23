import "dotenv/config";
import { archiveFlowResearch } from "@/lib/optionFlow/research/store";

archiveFlowResearch(process.argv.includes("--daily"), process.argv.includes("--rebuild"))
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error instanceof Error ? error.message : "期权流研究生成失败"); process.exitCode = 1; });
