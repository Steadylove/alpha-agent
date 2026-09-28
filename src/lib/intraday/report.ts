import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appConfig } from "../../../app.config";
import { eastern, easternMidnight, fetchQuotes, hash, manifestFile, readJson, researchRoot, safeId, shiftDate, symbolFile, writeJson } from "./researchData";
import { emptyFunnel, replaySymbol } from "./resonance";
import { simulate } from "./simulation";
import { intradaySignalSchema, signalId, tradeId } from "./protocol";
import type { Bar, DataManifest, Funnel, Profile, Quote, ResearchEvent, ResearchIndex, ResearchReport, SymbolData } from "./researchTypes";

export const reportFile=(id:string)=>path.join(researchRoot(),"reports",`${safeId(id)}.json`);
export const quoteFile=(dataId:string,symbol:string,date:string)=>path.join(researchRoot(),"quotes",safeId(dataId),`${symbol.replace(":","-")}-${date}.json.gz`);
function codeHash(){return hash(["resonance.ts","simulation.ts","researchTypes.ts","report.ts","researchData.ts","protocol.ts"].map(f=>readFileSync(path.join(process.cwd(),"src/lib/intraday",f),"utf8")).join("\n")+readFileSync(path.join(process.cwd(),"app.config.ts"),"utf8")+readFileSync(path.join(process.cwd(),"docs/tradingview-intraday-resonance.pine"),"utf8"));}
function xml(s:string){return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");}
export function saveReport(r:ResearchReport) {
  writeJson(reportFile(r.id),r);
  const indexFile=path.join(researchRoot(),"reports/index.json");
  const index:ResearchIndex=existsSync(indexFile)?readJson(indexFile):{version:1,updatedAt:r.builtAt,latest:r.id,runs:[]};
  index.runs=index.runs.filter(x=>x.id!==r.id);
  index.runs.push({id:r.id,builtAt:r.builtAt,profile:r.profile,source:r.source,from:r.from,to:r.to,symbols:r.universeCount,signals:r.signalCount,precision:r.scenarios[0]?.precision??"diagnostic"});
  index.runs.sort((a,b)=>b.builtAt.localeCompare(a.builtAt));index.latest=r.id;index.updatedAt=r.builtAt;writeJson(indexFile,index);
  const row=(cells:unknown[])=>cells.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",");
  const trades=r.scenarios[0]?.trades??[];
  writeFileSync(reportFile(r.id).replace(/\.json$/,".csv"),"\uFEFF"+[row(["symbol","entry_time_utc","exit_time_utc","entry_price","qty","remaining","net_realized_usd","fees_usd","status","exit_reason"]),...trades.map(t=>row([t.symbol,new Date(t.entryTime).toISOString(),t.exitTime?new Date(t.exitTime).toISOString():null,t.entry,t.qty,t.remaining,t.net,t.fees,t.status,t.exitReason]))].join("\r\n"));
  const html=`<!doctype html><meta charset="utf-8"><title>日内策略研究</title><style>body{background:#101113;color:#d8e3df;font:16px/1.7 sans-serif;max-width:1100px;margin:50px auto;padding:20px}h1{font-family:Georgia,serif}small{color:#8daf9f}table{width:100%;border-collapse:collapse}td,th{padding:10px;text-align:left;border-bottom:1px solid #304039}a{color:#94cdb7}</style><small>TREND ADAPTIVE / INTRADAY RESEARCH</small><h1>日内共振 · ${xml(r.profile)}</h1><p>${r.from} — ${r.to} · ${r.completed}/${r.universeCount} 股票 · ${r.signalCount} 条信号</p><ul>${r.warnings.map(w=>`<li>${xml(w)}</li>`).join("")}</ul><table><tr><th>情景</th><th>净收益</th><th>账户变化</th><th>最大回撤</th><th>已平仓 / 未平仓</th></tr>${r.scenarios.map(s=>`<tr><td>${xml(s.label)} / ${s.precision}</td><td>$${s.net.toFixed(2)}</td><td>${s.returnPct.toFixed(2)}%</td><td>${s.maxDrawdownPct.toFixed(2)}%</td><td>${s.closed} / ${s.open}</td></tr>`).join("")}</table><p>仅供信息参考，不构成投资建议。信号和模拟成交不是券商真实成交。</p>`;
  writeFileSync(reportFile(r.id).replace(/\.json$/,".html"),html);
  return r;
}
export function latestDataset() {
  const root=path.join(researchRoot(),"datasets");if(!existsSync(root))throw new Error("尚无历史数据，请先 fetch");
  const rows=readdirSync(root).filter(s=>existsSync(manifestFile(s))).map(s=>readJson<DataManifest>(manifestFile(s)));
  const latest=rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];if(!latest)throw new Error("尚无历史数据");return latest.id;
}
export function buildReport(dataId:string,profile:Profile,precision:"bars"|"quotes"="bars",imported?:ResearchEvent[]) {
  const m=readJson<DataManifest>(manifestFile(dataId)), sourceHash=codeHash();
  const parameters={...appConfig.intradayResearch,profile,precision,universeBias:"exploratory_current_universe",stopModel:precision==="quotes"?"minute_confirmed_quote_exit":"minute_confirmed_next_open",settlementCalendar:"trading_days_approximation"};
  const quoteRoot=path.join(researchRoot(),"quotes",safeId(dataId));
  const quoteVersion=precision==="quotes"&&existsSync(quoteRoot)?hash(readdirSync(quoteRoot).sort().map(f=>`${f}:${hash(readFileSync(path.join(quoteRoot,f)))}`).join("\n")):"none";
  const id=`${imported?"tv":"offline"}-${m.to}-${profile}-${precision}-${hash(JSON.stringify([m.checksums,parameters,sourceHash,quoteVersion,imported??null])).slice(0,12)}`;
  if(existsSync(reportFile(id)))return readJson<ResearchReport>(reportFile(id));
  const r:ResearchReport={version:1,id,builtAt:new Date().toISOString(),source:imported?"tv":"offline",profile,dataId,from:m.from,to:m.to,sessions:m.sessions,universeCount:m.universe.length,completed:m.completed.length,failed:{...m.failed},empty:m.empty,barCount:0,symbolDays:0,missingSymbolDays:0,floatCoverage:0,warmupInsufficient:0,funnel:emptyFunnel(),signalCount:0,events:[],scenarios:[],warnings:["探索性结果：当前股票池按近期行情选出，回看该区间存在选池偏差和幸存者偏差。","尚未完成与 TradingView 同源 K 线的逐根对照；不同数据源和日线成交量口径可能影响信号。"],sourceHash,universeHash:m.universeHash,parameters,diagnostics:[]};
  const simulationBars=new Map<string,Bar[]>(),quotes=new Map<string,Quote[]>();
  const importedInRange=imported?.filter(e=>{const day=eastern(e.payload.signalTime).date;return day>=m.from&&day<=m.to;});
  for(const symbol of m.universe) {
    if(!m.completed.includes(symbol)){r.missingSymbolDays+=m.sessions.length;continue;}
    const file=symbolFile(dataId,symbol);
    if(hash(readFileSync(file))!==m.checksums[symbol])throw new Error(`数据校验失败 ${symbol}`);
    const data=readJson<SymbolData>(file),replay=replaySymbol(data,m.from,m.to,profile);
    const inRange=data.bars.filter(b=>{const d=eastern(b.t).date;return d>=m.from&&d<=m.to;});
    const observed=new Set(inRange.filter(b=>eastern(b.t).minute<570).map(b=>eastern(b.t).date));
    r.barCount+=inRange.length;r.symbolDays+=observed.size;r.missingSymbolDays+=m.sessions.length-observed.size;
    if(data.floats.length)r.floatCoverage++;
    const cold=data.bars.filter(b=>eastern(b.t).date<m.from).length<appConfig.intradayResearch.warmupBars;if(cold)r.warmupInsufficient++;
    for(const k of Object.keys(r.funnel) as (keyof Funnel)[])r.funnel[k]+=replay.funnel[k];
    const events=importedInRange?importedInRange.filter(e=>e.payload.symbol===symbol):replay.events;r.events.push(...events);
    r.diagnostics.push({symbol,bars:inRange.length,sessionDays:observed.size,signals:events.length,issue:replay.discontinuities.length?`拆并股待核验：${replay.discontinuities.join(",")}`:cold?"起始预热不足，后续达到门槛才参与":null});
    if(profile!=="formula-only"&&events.some(e=>e.payload.event==="entry")) {
      simulationBars.set(symbol,inRange);
      if(precision==="quotes") {
        const needed=[...new Set(events.filter(e=>e.payload.event==="entry").map(e=>eastern(e.payload.signalTime).date))];
        const qs:Quote[]=[];
        for(const day of needed){const file=quoteFile(dataId,symbol,day);if(existsSync(file)){const cached=readJson<{quotes:Quote[];complete:boolean}>(file);if(cached.complete){for(const q of cached.quotes)qs.push(q);}else r.warnings.push(`${symbol} ${day} 报价补采未完成`);}else r.warnings.push(`${symbol} ${day} 报价缺失`);}
        const unique=new Map(qs.map(q=>[JSON.stringify(q),q]));quotes.set(symbol,[...unique.values()].sort((a,b)=>a.t-b.t));
      }
    }
  }
  if(imported) {
    const missing=importedInRange!.filter(e=>!m.universe.includes(e.payload.symbol));r.warnings.push(`TV 导入 ${imported.length} 条；${imported.length-importedInRange!.length} 条不在测试日期内，${missing.length} 条区间内标的不在本数据集，未模拟。`);
  }
  r.events.sort((a,b)=>a.payload.signalTime-b.payload.signalTime||a.payload.symbol.localeCompare(b.payload.symbol));r.signalCount=r.events.length;
  if(profile!=="formula-only")r.scenarios=[simulate(r.events,simulationBars,m.sessions,{precision,quotes}),simulate(r.events,simulationBars,m.sessions,{precision,quotes,costMultiplier:2,latencyMs:5000})];
  else r.warnings.push("原始共振仅校验信号，未执行资金账户模拟；不是完整筛选策略成绩。");
  if(profile==="price-volume")r.warnings.push("本口径未使用历史 Float；是价格/成交量研究变体，不是完整低流通盘策略。");
  if(profile==="strict")r.warnings.push(`历史 Float 覆盖 ${r.floatCoverage}/${r.universeCount}；缺失时拒绝入场，零交易不能据此判断策略优劣。`);
  const split=r.diagnostics.filter(d=>d.issue?.startsWith("拆并股"));if(split.length)r.warnings.push(`${split.length} 只股票存在拆并股线索，已跳过信号计算，等待公司行动核验。`);
  if(r.missingSymbolDays)r.warnings.push(`${r.missingSymbolDays} 个股票日未观察到盘前有效 K 线；可能无成交或数据不足，未填造 K 线。`);
  if(r.warmupInsufficient)r.warnings.push(`${r.warmupInsufficient} 只股票在测试起点不足 500 根预热，达到门槛后才参与。`);
  if(precision==="quotes")r.warnings.push("报价版已计入价差和延迟；分钟止损、盘口排队与特殊结算假日仍是模型近似。");
  r.warnings=[...new Set(r.warnings)];return saveReport(r);
}
export async function supplementQuotes(runId:string,log:(s:string)=>void=console.log) {
  const report=readJson<ResearchReport>(reportFile(runId));if(report.profile==="formula-only")throw new Error("先使用 price-volume 口径定位交易，再补报价");
  const groups=new Map<string,{symbol:string;date:string;from:number}>();
  for(const e of report.events.filter(e=>e.payload.event==="entry")){const date=eastern(e.payload.signalTime).date,key=`${e.payload.symbol}/${date}`,old=groups.get(key);groups.set(key,{symbol:e.payload.symbol,date,from:Math.min(e.payload.signalTime-60000,old?.from??Infinity)});}
  let done=0;
  for(const g of groups.values()) {
    const file=quoteFile(report.dataId,g.symbol,g.date);
    if(!existsSync(file)||!readJson<{complete:boolean}>(file).complete){
      try{const quotes=await fetchQuotes(g.symbol,g.from,easternMidnight(shiftDate(g.date,1))-1);writeJson(file,{complete:true,fetchedAt:new Date().toISOString(),from:g.from,quotes},true);}
      catch(e){writeJson(file,{complete:false,error:e instanceof Error?e.message:"failed",quotes:[]},true);throw e;}
    }
    log(`报价 ${++done}/${groups.size} ${g.symbol} ${g.date}`);
  }
  return {groups:groups.size};
}
export function importTvJournal(file:string):ResearchEvent[] {
  const raw=readJson<unknown>(file);const rows=Array.isArray(raw)?raw:(raw as {records?:unknown[]})?.records;
  if(!Array.isArray(rows))throw new Error("TV 档案需要 records 数组");
  const seen=new Set<string>();
  return rows.map(row=>{
    const r=row as {payload:unknown;receivedAt:number};const p=intradaySignalSchema.parse(r.payload);
    if(!Number.isFinite(r.receivedAt))throw new Error("TV 原始接收时间缺失，不能用历史信号时间替代");
    return {id:signalId(p),tradeId:tradeId(p),source:"tv" as const,observedAt:r.receivedAt,payload:p};
  }).filter(e=>{if(seen.has(e.id))return false;seen.add(e.id);return true;});
}
