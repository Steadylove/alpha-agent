import type { History } from './history';
import type { SeriesMarker, Time } from 'lightweight-charts';

export type Execution = {id:string;symbol:string;local_symbol:string;con_id?:number;type:string;side:string;quantity:number|null;price:number|null;currency:string;exchange:string;time:string;commission:number|null;commission_currency:string|null};
export type TradeGroup = {id:string;time:number|string;side:'buy'|'sell';quantity:number;price:number;entries:Execution[]};
export type TradeMap = {groups:TradeGroup[];matched:number;eligible:number;unmapped:number};
const durations:Record<string,number>={'1m':60,'5m':300,'15m':900,'1h':3600};
const nyFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function nyTime(seconds:number) {
  const parts=Object.fromEntries(nyFormat.formatToParts(new Date(seconds*1000)).map(p=>[p.type,p.value]));
  return {day:`${parts.year}-${parts.month}-${parts.day}`,second:Number(parts.hour)*3600+Number(parts.minute)*60+Number(parts.second)};
}
export const tradeTime=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value))+' ET';
export const tradeNumber=(value:number)=>value.toLocaleString('en-US',{maximumFractionDigits:4});

export function alignExecutions(history:History|null, executions:Execution[]):TradeMap {
  if (!history) return {groups:[],matched:0,eligible:0,unmapped:0};
  const bars=history.bars;
  const groupMap=new Map<string,TradeGroup>(), seen=new Set<string>();
  const dayBars=new Map(bars.filter(b=>typeof b.time==='string').map(b=>[String(b.time),b.time]));
  let eligible=0,matched=0;
  for (const execution of executions) {
    if (!execution.id || seen.has(execution.id) || execution.symbol!==history.symbol || execution.type!=='STK' || execution.currency!=='USD') continue;
    if (history.con_id && execution.con_id!==history.con_id) continue;
    const side=execution.side==='BOT'||execution.side==='BUY'?'buy':execution.side==='SLD'||execution.side==='SELL'?'sell':null;
    const quantity=execution.quantity, price=execution.price;
    // Never infer a timezone from the browser or a fill from a position/cost basis.
    if (!side || quantity==null || price==null || !Number.isFinite(quantity) || !Number.isFinite(price) || quantity<=0 || price<=0 || !/(Z|[+-]\d{2}:\d{2})$/i.test(execution.time)) continue;
    const seconds=Date.parse(execution.time)/1000;
    if (!Number.isFinite(seconds)) continue;
    seen.add(execution.id);eligible++;
    const local=nyTime(seconds);
    if (history.rth && (local.second<9*3600+30*60 || local.second>16*3600)) continue;
    let barTime:number|string|undefined;
    if (history.period==='1d') barTime=dayBars.get(local.day);
    else if (durations[history.period]) {
      // Locate the actual returned bar, including IBKR's shortened opening bars.
      let low=0,high=bars.length-1,index=-1;
      while (low<=high) { const mid=(low+high)>>1;
        if (Number(bars[mid].time)<=seconds) {index=mid;low=mid+1;} else high=mid-1;
      }
      if (index>=0 && typeof bars[index].time==='number') {
        const start=bars[index].time as number;
        let end=Math.min(start+durations[history.period],Number(bars[index+1]?.time??Infinity));
        const barLocal=nyTime(start);
        if (history.rth) end=Math.min(end,start+16*3600-barLocal.second);
        const closingAuction=history.rth && local.second===16*3600 && seconds===end;
        if (local.day===barLocal.day && (seconds<end || closingAuction)) barTime=start;
      }
    }
    if (barTime===undefined) continue;
    matched++;
    const id=`${history.symbol}:${barTime}:${side}`;
    const group=groupMap.get(id)??{id,time:barTime,side,quantity:0,price:0,entries:[]};
    group.price=(group.price*group.quantity+price*quantity)/(group.quantity+quantity);
    group.quantity+=quantity;group.entries.push(execution);groupMap.set(id,group);
  }
  const groups=[...groupMap.values()].sort((a,b)=>String(a.time).localeCompare(String(b.time),undefined,{numeric:true})||a.side.localeCompare(b.side));
  for (const group of groups) group.entries.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||a.id.localeCompare(b.id));
  return {groups,matched,eligible,unmapped:eligible-matched};
}

export function tradeMarkers(groups:TradeGroup[]):SeriesMarker<Time>[] {
  return groups.map(g=>({id:g.id,time:g.time as Time,position:g.side==='buy'?'atPriceBottom':'atPriceTop',
    shape:g.side==='buy'?'arrowUp':'arrowDown',color:g.side==='buy'?'#267057':'#b05b43',
    price:g.price,text:`${g.side==='buy'?'B':'S'} ${tradeNumber(g.quantity)}`,size:1}));
}
