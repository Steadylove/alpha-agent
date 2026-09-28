import { loadLocalEnvironment } from "./env";
import path from "node:path";
import { downloadUniverse, parseUniverse, readJson, researchRoot, writeJson } from "../src/lib/intraday/researchData";
import { buildReport, importTvJournal, latestDataset, reportFile, supplementQuotes } from "../src/lib/intraday/report";
import type { Profile, ResearchIndex, ResearchReport } from "../src/lib/intraday/researchTypes";

loadLocalEnvironment();
const args = process.argv.slice(2);
const value = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] ?? fallback; };
async function main() {
  if (args[0] === "export") {
    const output=value("out","");if(!output)throw new Error("请提供 --out 派生报告输出目录");
    const index=readJson<ResearchIndex>(path.join(researchRoot(),"reports/index.json"));
    // Public export contains offline research only, never original TV receipts or raw market data.
    index.runs=index.runs.filter(r=>r.source==="offline");
    const keys=new Set<string>();
    index.runs=index.runs.sort((a,b)=>b.builtAt.localeCompare(a.builtAt)).filter(r=>{const k=`${r.from}/${r.to}/${r.profile}/${r.precision}`;if(keys.has(k))return false;keys.add(k);return true;});
    if(!index.runs.length)throw new Error("没有可导出的离线报告");
    for(const run of index.runs) {
      const report=readJson<ResearchReport>(reportFile(run.id));
      writeJson(path.join(output,`${run.id}.json`),report);
      writeJson(path.join(output,`${run.id}.json.gz`),report,true);
      const preview={...report,events:report.events.slice(0,500)};
      writeJson(path.join(output,`${run.id}.page.json`),preview);
      writeJson(path.join(output,`${run.id}.page.json.gz`),preview,true);
      writeJson(reportFile(run.id).replace(/\.json$/,".page.json"),preview);
    }
    index.latest=index.runs[0].id;writeJson(path.join(output,"index.json"),index);
    console.log(JSON.stringify({output:path.resolve(output),reports:index.runs.length}));return;
  }
  if (args[0] === "replay" || args[0] === "reconcile") {
    const profile=value("profile","price-volume"),precision=value("fills","bars");
    if(!["formula-only","price-volume","strict"].includes(profile)||!["bars","quotes"].includes(precision))throw new Error("研究口径或成交模式无效");
    const report=buildReport(value("dataset",latestDataset()),profile as Profile,precision as "bars"|"quotes",args[0]==="reconcile"?importTvJournal(value("journal","")):undefined);
    console.log(JSON.stringify({id:report.id,symbols:report.completed,bars:report.barCount,signals:report.signalCount,funnel:report.funnel,scenarios:report.scenarios.map(s=>({label:s.label,net:s.net,closed:s.closed,open:s.open,winRate:s.winRate,rejected:s.rejected})),warnings:report.warnings},null,2));return;
  }
  if(args[0]==="quotes"){console.log(await supplementQuotes(value("run","")));return;}
  if (args[0] !== "fetch") throw new Error("用法：intraday-lab fetch | replay | quotes | reconcile | export");
  const limit = Number(value("limit", "1000")), sessions = Number(value("sessions", "20"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(sessions) || sessions < 1 || sessions > 120) throw new Error("股票数量 1–1000，交易日 1–120");
  const universe = parseUniverse(value("universe", "docs/tradingview-intraday-1000.txt")).slice(0, limit);
  const end = value("end", "");
  if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("结束日期无效");
  const result = await downloadUniverse(universe, sessions, end || undefined);
  console.log(JSON.stringify({ id: result.id, completed: result.completed.length, failed: result.failed, from: result.from, to: result.to }));
  if (Object.keys(result.failed).length) process.exitCode = 1;
}
main().catch(e => { console.error(e instanceof Error ? e.message : "研究任务失败"); process.exitCode = 1; });
