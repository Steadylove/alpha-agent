/** 真实历史行情预览；仅写本地文件，不访问入场日志或消息发送接口。 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildAlertView, type AlertPayload } from "@/lib/discord/tvAlertCopy";
import { renderSignalOgPng } from "@/lib/discord/signalCardOg";
import { signalCardSvg } from "@/lib/discord/signalCardImage";
import { signalCardLayout } from "@/lib/discord/signalCardLayout";
import { QUALITY_VERSION, signalReturnOf, tradeReviewOf, type EntrySnapshot } from "@/lib/signals/assessment";
import { emaSeries } from "@/lib/scoring/series";
import { aggregateMinuteWindow, minuteVolumeSnapshot, prepareMinutes, reconcileParent, type MinuteBar } from "./lib/signalVolumeReplay";

type Replay = { payload: AlertPayload; view: { rps?: number } };
type MinuteFile = { source: string; symbol: string; timeframe: string; adjustment: string; start: string; end: string; fetchedAt: string; bars: MinuteBar[] };

async function fetchMinutes(symbol: string, from: number, to: number, timeframe: "1Min" | "30Min"): Promise<MinuteFile> {
  const { config } = await import("dotenv");
  config({ quiet:true });
  const { alpacaCredentials } = await import("@/lib/data-sources/alpaca");
  const { key, secret } = alpacaCredentials();
  assert(to > from && to-from <= 100*86400000, "预览下载范围限制为 100 天");
  const result: MinuteFile = { source:"Alpaca SIP",symbol,timeframe,adjustment:"all",start:new Date(from).toISOString(),
    end:new Date(to).toISOString(),fetchedAt:new Date().toISOString(),bars:[] };
  let token: string | null = null, pages = 0;
  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    for (const [name,value] of Object.entries({timeframe,start:result.start,end:result.end,limit:"10000",adjustment:"all",feed:"sip",sort:"asc"})) url.searchParams.set(name,value);
    if (token) url.searchParams.set("page_token",token);
    const response = await fetch(url,{headers:{"APCA-API-KEY-ID":key,"APCA-API-SECRET-KEY":secret},signal:AbortSignal.timeout(20000)});
    assert(response.ok,`Alpaca 行情下载 HTTP ${response.status}`);
    const data = await response.json() as { bars?: MinuteBar[]; next_page_token?: string | null };
    assert(Array.isArray(data.bars),"Alpaca 返回的分钟行情无效");
    result.bars.push(...data.bars);
    token = data.next_page_token ?? null;
    console.log(JSON.stringify({download:symbol,timeframe,page:++pages,rows:data.bars.length,more:!!token}));
    assert(pages < 10 || !token,"分钟下载超出预览所需范围");
  } while (token);
  assert(result.bars.length,"未取得分钟行情");
  return result;
}

function verifyChart(payload: AlertPayload, market: Map<number, number[]>) {
  const chart = payload.chart as { version: number; stride: number; bars: number[][] };
  assert(chart?.version === 1 && chart.stride === 1 && chart.bars.length > 20, "需要未压缩的真实行情快照");
  for (const bar of chart.bars) {
    const source = market.get(bar[0]);
    assert(source, `CSV 缺少 ${new Date(bar[0]).toISOString()} 的行情`);
    for (let i = 0; i < 4; i++) assert(Math.abs(bar[i+2]-source[i]) <= .000051, "K 线 OHLC 与源行情不一致");
    assert(bar[1] <= payload.barTime!, "图中不能包含信号之后的行情");
  }
  assert.equal(chart.bars.at(-1)![5], payload.price);
  assert.equal(chart.bars.at(-1)![1], payload.barTime);
}

async function main() {
  const sourceDirectory = ".cache/previews/pl-latest-2026-09-11";
  const { values } = parseArgs({ options: {
    buy: { type: "string", default: `${sourceDirectory}/PL-buy-2026-09-02.json` },
    sell: { type: "string", default: `${sourceDirectory}/PL-sell-2026-09-10.json` },
    market: { type: "string", default: `${sourceDirectory}/market/4h/PL.csv` },
    out: { type: "string", default: ".cache/previews/signal-assessment-v2" },
    minutes: { type: "string" },
    reference: { type: "string" },
    "fetch-minutes": { type: "boolean", default: false },
  } });
  const out=path.resolve(values.out!);
  mkdirSync(out,{recursive:true});
  const market = new Map(readFileSync(values.market!, "utf8").trim().split(/\r?\n/).slice(1).map(line => {
    const [date, ...numbers] = line.split(",");
    return [Date.parse(`${date}Z`), numbers.map(Number)] as const;
  }));
  const records = [values.buy!,values.sell!].map(file=>({file,...JSON.parse(readFileSync(file,"utf8")) as Replay}));
  const symbol = records[0].payload.symbol;
  assert(records.every(r=>r.payload.symbol===symbol),"预览必须是同一个标的");
  const minutePath = values.minutes ?? path.join(out,`${symbol}-minute-sip.json`);
  const referencePath = values.reference ?? path.join(out,`${symbol}-30min-sip.json`);
  if (values["fetch-minutes"]) {
    const from = Math.min(...records.map(r=>(r.payload.chart as {bars:number[][]}).bars[0][0]))-7*86400000;
    const to = Math.max(...records.map(r=>r.payload.barTime!));
    writeFileSync(minutePath,JSON.stringify(await fetchMinutes(symbol,from,to,"1Min")));
    writeFileSync(referencePath,JSON.stringify(await fetchMinutes(symbol,from,to,"30Min")));
  }
  const minuteData: MinuteFile | undefined = existsSync(minutePath) ? JSON.parse(readFileSync(minutePath,"utf8")) : undefined;
  const referenceData: MinuteFile | undefined = existsSync(referencePath) ? JSON.parse(readFileSync(referencePath,"utf8")) : undefined;
  if (minuteData) assert(minuteData.symbol === symbol && minuteData.timeframe === "1Min" && minuteData.source === "Alpaca SIP", "分钟数据标的或来源不一致");
  if (minuteData) assert(referenceData?.symbol===symbol && referenceData.timeframe==="30Min" && referenceData.source==="Alpaca SIP" &&
    referenceData.adjustment===minuteData.adjustment,"缺少同源同复权的 30 分钟参照，请使用 --fetch-minutes 补齐");
  let entry: EntrySnapshot | undefined;
  for (const { file:sourceFile, payload, view:previous } of records) {
    const event = payload.event;
    assert(event === "buy" || event === "sell");
    assert.equal(payload.tf, "240", "当前真实示例使用 4H 数据");
    verifyChart(payload, market);
    let minuteAudit;
    if (minuteData) {
      const chart = payload.chart as { version:1; stride:number; bars:number[][] };
      const minutes = prepareMinutes(minuteData.bars,payload.barTime!);
      // 缺失分钟不填充，用另一次 30m 下载独立核对每根父级量；98%–102% 沿用服务端规则。
      const parents = chart.bars.map(b=>reconcileParent(aggregateMinuteWindow(b[0],b[1],minutes,false),referenceData!.bars));
      const corrected = new Map(parents.map(p=>[p.bar[0],p.bar]));
      const rows = [...market.entries()].filter(([time])=>time<=chart.bars.at(-1)![0]);
      const prices = rows.map(([time,ohlcv])=>corrected.get(time)?.[5] ?? ohlcv[3]);
      const emas = [166,169,576,676].map(n=>emaSeries(prices,n));
      const rowIndex = new Map(rows.map(([time],index)=>[time,index]));
      minuteAudit = { method:"同源 1m 与独立 30m 交叉校验；展示使用重新下载的 30m 聚合 OHLC，净量和分布使用 1m", parentBars:parents.length,
        originalSignalPrice:payload.price, refreshedSignalPrice:parents.at(-1)!.bar[5],
        indicatorWindowMissingMinutes:parents.slice(-20).reduce((sum,p)=>sum+(p.bar[1]-p.bar[0])/60000-p.samples.length,0),
        chartMissingMinutes:parents.reduce((sum,p)=>sum+(p.bar[1]-p.bar[0])/60000-p.samples.length,0),
        minCoverage:Math.min(...parents.slice(-20).map(p=>p.bar[8]/p.bar[6])),
        maxCoverage:Math.max(...parents.slice(-20).map(p=>p.bar[8]/p.bar[6])),
        maxOldOhlcDifference:Math.max(...parents.flatMap((p,i)=>p.bar.slice(2,6).map((n,j)=>Math.abs(n-chart.bars[i][j+2])))),
        minMinuteToOldVolume:Math.min(...parents.map(p=>p.bar[6]/market.get(p.bar[0])![4])),
        maxMinuteToOldVolume:Math.max(...parents.map(p=>p.bar[6]/market.get(p.bar[0])![4])) };
      payload.chart = {version:1,stride:1,bars:parents.map(p=>[...p.bar.slice(0,6),...emas.map(e=>e[rowIndex.get(p.bar[0])!] ?? null)])};
      assert(Math.abs(parents.at(-1)!.bar[5]/payload.price-1)<.005,"重新取数的价格偏差超过 0.5%，需要复核历史交易");
      // 历史数据重新取数可能修订几厘/几分；示例价与新 K 线一致，旧价保存在审计信息中。
      payload.price = parents.at(-1)!.bar[5];
      if (event === "sell") {
        const held = parents.filter(p=>p.bar[0]>=payload.entryTime!);
        assert(held.length && held[0].bar[0]===payload.entryTime,"图示行情不足以重算持仓区间");
        payload.entry = held[0].bar[2];
        payload.highSinceEntry = Math.max(payload.entry,...held.map(p=>p.bar[3]));
        payload.lowSinceEntry = Math.min(payload.entry,...held.map(p=>p.bar[4]));
        payload.pnl = signalReturnOf(payload);
      }
      payload.volumeSnapshot = minuteVolumeSnapshot(parents);
    }
    const view=buildAlertView(payload,"4H",previous.rps);
    assert(view.chart, "行情快照未通过渲染校验");
    if (minuteData) assert(view.volume?.cvd.points != null && view.volume.profile.points != null,"真实分钟指标未通过校验");
    if (event === "buy") {
      entry = { version: 1, id: "local-preview-only", capturedAt: new Date().toISOString(), payload,
        quality: view.quality!, rps: previous.rps };
    } else {
      assert(entry && entry.payload.symbol === payload.symbol && entry.payload.strategyKey === payload.strategyKey &&
        entry.payload.entrySignalTime === payload.entrySignalTime, "买卖点不属于同一笔历史交易");
      view.assessment = tradeReviewOf(payload, entry, `历史行情回放；入场分按 ${QUALITY_VERSION} 重算，仅作预览；未计费用及下一根开盘价差`);
    }
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(payload.barTime);
    const name = `${payload.symbol}-${event}-${date}`;
    view.title += ` · 真实行情示例 ${date}`;
    const layout=signalCardLayout(view), svg=signalCardSvg(view);
    assert(!/财务与位置概览|盈利增速|基本面/.test(svg));
    const png=await renderSignalOgPng(view);
    assert.equal(png.readUInt32BE(16),1920);
    writeFileSync(path.join(out,`${name}.png`),png);
    writeFileSync(path.join(out,`${name}.svg`),svg);
    writeFileSync(path.join(out,`${name}.json`),JSON.stringify({source:{replay:path.resolve(sourceFile),market:path.resolve(values.market!),
      minutes:minuteData?path.resolve(minutePath):undefined,reference:minuteData?path.resolve(referencePath):undefined,minuteAudit,
      note:minuteData?"信号日期、策略阈值和排名沿用历史快照；价格及 OHLC/EMA 以新下载的同源行情更新，价格差异已记录；两个新指标采用分钟数据估算；仅预览，不改写历史日志":
        "OHLC 逐根核对源 CSV；排名取原历史快照；未提供的分钟量价指标保持缺失；不改写历史日志"},payload,view,layout},null,2));
    console.log(JSON.stringify({name,width:1920,height:layout.height*2,score:view.quality?.points,available:view.quality?.available}));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
