import { appConfig } from "../../../app.config";
import { digest, signalId, tradeId, type IntradaySignal } from "./protocol";
import { eastern } from "./researchData";
import type { Bar, Funnel, Profile, ReplayResult, SymbolData } from "./researchTypes";

const defaults = appConfig.intradayResearch;
export const emptyFunnel = (): Funnel => ({ bars:0,sessionBars:0,warmed:0,dailyReady:0,price:0,gain:0,volume:0,floatKnown:0,float:0,resonance:0,eligible:0,entries:0 });
export class Rma {
  private seed: number[] = []; value = NaN;
  constructor(readonly length: number) {}
  next(x: number) {
    if (!Number.isFinite(x)) return this.value;
    if (!Number.isFinite(this.value)) { this.seed.push(x); if(this.seed.length === this.length) this.value=this.seed.reduce((a,b)=>a+b,0)/this.length; }
    else this.value = (x + (this.length-1)*this.value)/this.length;
    return this.value;
  }
}
export class Cooldown {
  last = -Infinity;
  constructor(readonly bars: number) {}
  next(raw: boolean, index: number) { const emit=raw && index-this.last>this.bars; if(emit)this.last=index; return emit; }
}
const cross = (a: number, b: number, oldA: number, oldB: number) => a>b && oldA<=oldB;
export class ResonanceIndicators {
  private window: Bar[]=[]; private wrs: number[]=[];
  private r1=new Rma(3); private r2=new Rma(3); private r3=new Rma(3);
  private r9=new Rma(9); private rv1=new Rma(3); private rv2=new Rma(3);
  private buyFilter=new Cooldown(4); private topFilter=new Cooldown(5); private sellFilter=new Cooldown(4);
  private oversold=-Infinity; private pivotAt=-Infinity; private index=-1;
  private prev={ trend:NaN, powerline:NaN, main:NaN, fund:NaN, fund2:NaN, long:NaN, trend1:NaN };
  next(bar: Bar) {
    this.index++;this.window.push(bar);if(this.window.length>34)this.window.shift();
    const range=(n:number)=>{const w=this.window.slice(-n);return {low:Math.min(...w.map(b=>b.l)),high:Math.max(...w.map(b=>b.h))};};
    const pos=(n:number)=>{const r=range(n);return (bar.c-r.low)/Math.max(r.high-r.low,.0001)*100;};
    const raw27=pos(27),trend=this.r2.next(this.r1.next(raw27)),powerline=this.r3.next(trend);
    const wr=(n:number)=>{const r=range(n);return -100*(r.high-bar.c)/Math.max(r.high-r.low,.0001);};
    const wr34=wr(34), fund=wr(14)+100;
    this.wrs.push(wr34);if(this.wrs.length>19)this.wrs.shift();
    const long=this.wrs.length===19?this.wrs.reduce((a,b)=>a+b,0)/19+100:NaN;
    const main=Number.isFinite(this.prev.main)?0.4*(wr34+100)+.6*this.prev.main:wr34+100;
    const p=this.prev;
    const caopan=(long<12&&main<8&&(fund<7.2||p.fund<5)&&(main>p.main||fund>p.fund))||(long<8&&main<7&&fund<15&&fund>p.fund)||(long<10&&main<7&&fund<1);
    const fundCross=cross(fund,long,p.fund,p.long);
    const changduan=long<15&&p.long<15&&main<18&&fund>p.fund&&fundCross&&fund>main&&(p.fund<5||p.fund2<5)&&(main>=long||p.fund<1);
    if(caopan||changduan)this.oversold=this.index;
    if(fundCross&&fund>main&&long<35)this.pivotAt=this.index;
    const ind1=cross(trend,powerline,p.trend,p.powerline)&&trend<30;
    const premium=ind1&&this.index-this.oversold<=2,pivot=ind1&&this.index-this.pivotAt<=2;
    const cleanBuy=this.buyFilter.next(premium||pivot,this.index);
    const topZone=main<p.main&&p.main>80&&(p.fund>95||p.fund2>95)&&long>60&&fund<83.5&&fund<main&&fund<long+4;
    const top=this.topFilter.next(topZone,this.index);
    const r9=range(9),raw1b=(r9.high-bar.c)/Math.max(r9.high-r9.low,.0001)*100-70;
    const var2=this.r9.next(raw1b)+100,var5=this.rv2.next(this.rv1.next(pos(9)))+100;
    const trend1=Math.max(var5-var2-45,0);
    const sell=this.sellFilter.next((cross(powerline,trend,p.powerline,p.trend)&&trend1>50)||(trend1>70&&trend1<p.trend1),this.index);
    this.prev={trend,powerline,main,fund,fund2:p.fund,long,trend1};
    return {trend,powerline,main,fund,long,trend1,premium,pivot,cleanBuy,top,sell,stop:Math.min(...this.window.slice(-defaults.stopLookback).map(b=>b.l))};
  }
}
export function splitDiscontinuities(data: SymbolData) {
  let previous: number | undefined; const dates: string[]=[];
  for(const d of Object.keys(data.splitFactors).sort()) {
    const f=data.splitFactors[d];if(previous!==undefined&&Math.abs(f/previous-1)>.03)dates.push(d);previous=f;
  }
  return dates;
}
export function replaySymbol(data: SymbolData, from: string, to: string, profile: Profile, warmupBars: number = defaults.warmupBars): ReplayResult {
  const funnel=emptyFunnel();const result:ReplayResult={events:[],funnel,first:data.bars[0]?.t??null,last:data.bars.at(-1)?.t??null,discontinuities:splitDiscontinuities(data)};
  // Nominal prices across a split require audited corporate actions. Do not silently alter returns.
  if(result.discontinuities.length)return result;
  const indicator=new ResonanceIndicators();
  let currentDate="",dayVolume=0,priorClose=NaN,averageVolume=NaN;
  let entry: {price:number;stop:number;time:number;date:string;index:number;reduced:boolean}|null=null;
  const daily=[...data.daily].sort((a,b)=>a.t-b.t);let dailyIndex=0;
  const floats=[...data.floats].sort((a,b)=>a.availableAt-b.availableAt);let floatIndex=0,floatShares=NaN;
  const parameters={scanner:profile!=="formula-only",filterProfile:profile,minPrice:defaults.minPrice,maxPrice:defaults.maxPrice,minGain:defaults.minGainPct,minRvol:defaults.minVolumeRatio,maxFloat:defaults.maxFloat,stopLookback:defaults.stopLookback,closeAtEnd:true,session:"0400-0930",buyCooldown:4,sellCooldown:4,topCooldown:5,resonanceBars:3,newsRequired:false};
  const strategyKey=`resonance-${defaults.version}-${digest(parameters).slice(0,24)}`;
  for(let i=0;i<data.bars.length;i++) {
    const b=data.bars[i],et=eastern(b.t);if(et.date>to)break;
    if(et.date!==currentDate) {
      currentDate=et.date;dayVolume=0;
      while(dailyIndex<daily.length&&eastern(daily[dailyIndex].t).date<et.date)dailyIndex++;
      priorClose=dailyIndex?daily[dailyIndex-1].c:NaN;
      averageVolume=dailyIndex>=50?daily.slice(dailyIndex-50,dailyIndex).reduce((s,v)=>s+v.v,0)/50:NaN;
    }
    dayVolume+=b.v;
    while(floatIndex<floats.length&&floats[floatIndex].availableAt<=b.t+60000)floatShares=floats[floatIndex++].shares;
    const v=indicator.next(b),gain=priorClose>0?(b.c/priorClose-1)*100:NaN,rvol=averageVolume>0?dayVolume/averageVolume:NaN;
    if(et.date<from)continue;
    funnel.bars++;
    const inSession=et.minute>=240&&et.minute<570&&et.weekday>0&&et.weekday<6;
    const warmed=i>=warmupBars;
    const dailyReady=Number.isFinite(gain)&&Number.isFinite(rvol);
    const price=b.c>=defaults.minPrice&&b.c<=defaults.maxPrice,gainOk=gain>=defaults.minGainPct,volumeOk=rvol>=defaults.minVolumeRatio;
    const known=Number.isFinite(floatShares)&&floatShares>0,floatOk=known&&floatShares<defaults.maxFloat;
    const eligible=profile==="formula-only"||dailyReady&&price&&gainOk&&volumeOk&&(profile!=="strict"||floatOk);
    if(inSession) {
      funnel.sessionBars++;if(warmed){funnel.warmed++;if(dailyReady){funnel.dailyReady++;if(price){funnel.price++;if(gainOk){funnel.gain++;if(volumeOk){funnel.volume++;if(known)funnel.floatKnown++;if(floatOk)funnel.float++;}}}}}
      if(warmed&&v.cleanBuy)funnel.resonance++;
      if(warmed&&eligible&&v.cleanBuy)funnel.eligible++;
    }
    const metric=(x:number)=>Number.isFinite(x)?x:null;
    const emit=(event:IntradaySignal["event"],reason:string,price:number) => {
      const payload:IntradaySignal={protocol:"intraday-v1",strategy:"resonance-long",scriptVersion:defaults.version,strategyKey,symbol:data.symbol,tf:"1",event,reason,barTime:b.t,signalTime:b.t+60000,entrySignalTime:event==="watch"?null:entry!.time,price,entryPrice:event==="watch"?null:entry!.price,stop:event==="watch"?v.stop:entry!.stop,
        metrics:{gainPct:metric(gain),rvol:metric(rvol),dayVolume,floatShares:metric(floatShares),trend:metric(v.trend),powerline:metric(v.powerline),longLine:metric(v.long),fundLine:metric(v.fund),mainLine:metric(v.main),trend1:metric(v.trend1),premium:v.premium,pivot:v.pivot,top:v.top,reduce:v.sell,newsVerified:false},parameters};
      result.events.push({id:signalId(payload),tradeId:tradeId(payload),source:"offline",observedAt:null,payload});
    };
    let closed=false;
    if(entry&&i>entry.index&&b.l<=entry.stop){emit("stop","stop_touch",Math.min(b.o,entry.stop));entry=null;closed=true;}
    if(entry) {
      const gap=entry.date!==et.date||!inSession;
      if(v.top||et.minute===569||gap){emit("exit",v.top?"resonance_top":gap?"session_gap":"session_end",b.c);entry=null;closed=true;}
      else if(v.sell&&!entry.reduced){emit("partial","resonance_reduce",b.c);entry.reduced=true;}
    }
    if(warmed&&inSession&&et.minute!==569&&v.cleanBuy&&eligible&&!closed) {
      const reason=v.premium?"premium_resonance":"pivot_resonance";
      if(!entry&&v.stop>0&&v.stop<b.c){entry={price:b.c,stop:v.stop,time:b.t+60000,date:et.date,index:i,reduced:false};emit("entry",reason,b.c);funnel.entries++;}
      else emit("watch",reason,b.c);
    }
  }
  return result;
}
