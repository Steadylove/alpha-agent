import { appConfig } from "../../../app.config";
import { digest } from "./protocol";
import { eastern } from "./researchData";
import type { Bar, Quote, ResearchEvent, SimTrade, Simulation } from "./researchTypes";

const base=appConfig.intradayResearch;
type Order={event:ResearchEvent;ready:number;expires:number;limit:number|null;lastLimitAt:number;reserved:number;remainingTarget:number};
type Action={time:number;priority:number;symbol:string;event?:ResearchEvent;bar?:Bar;quote?:Quote;kind:"event"|"open"|"close"|"quote"};
export function simulate(events:ResearchEvent[], bars:Map<string,Bar[]>, sessions:string[], options:{precision?:"bars"|"quotes";quotes?:Map<string,Quote[]>;costMultiplier?:number;latencyMs?:number;initialCash?:number}={}):Simulation {
  const precision=options.precision??"bars", multiplier=options.costMultiplier??1,latency=options.latencyMs??base.latencyMs,initial=options.initialCash??base.initialCash;
  const out:Simulation={label:multiplier===1?"基础成本":"双倍成本",precision,initialCash:initial,equity:initial,net:0,returnPct:0,maxDrawdownPct:0,closed:0,open:0,wins:0,winRate:null,averageWin:null,averageLoss:null,expectancy:null,profitFactor:null,consecutiveLosses:0,fees:0,trades:[],executions:[],rejected:{},days:[],warnings:[precision==="bars"?"分钟成交近似：确认及延迟后，向上取整到下一分钟开盘；止损也在分钟确认后排队退出。":"历史报价成交估计；止损仍由完整分钟线确认，未实现逐笔首次触及，不等于实盘执行。","名义风险是仓位预算；跳空、停牌和流动性不足时损失可以超过预算。","现金模型只用已结算资金；本次区间结算采用提供的交易日日历，特殊结算假日尚需核验。"]};
  const actions:Action[]=[];
  const relevant=new Set(events.filter(e=>e.payload.event==="entry").map(e=>e.payload.symbol));
  const starts=new Map<string,number>(); for(const e of events) if(e.payload.event==="entry")starts.set(e.payload.symbol,Math.min(starts.get(e.payload.symbol)??Infinity,e.payload.signalTime));
  for(const e of events)if(e.payload.event!=="watch")actions.push({time:Math.max(e.payload.signalTime,e.observedAt??0),priority:1,symbol:e.payload.symbol,event:e,kind:"event"});
  for(const symbol of relevant) {
    for(const b of bars.get(symbol)??[])if(b.t+60000>=starts.get(symbol)!&&eastern(b.t).date>=sessions[0]&&eastern(b.t).date<=sessions.at(-1)!) {
      actions.push({time:b.t,priority:3,symbol,bar:b,kind:"open"},{time:b.t+60000,priority:0,symbol,bar:b,kind:"close"});
    }
    if(precision==="quotes") for(const q of options.quotes?.get(symbol)??[])actions.push({time:q.t,priority:2,symbol,quote:q,kind:"quote"});
  }
  actions.sort((a,b)=>a.time-b.time||a.priority-b.priority||((a.event?.payload.reason==="premium_resonance"?0:1)-(b.event?.payload.reason==="premium_resonance"?0:1))||a.symbol.localeCompare(b.symbol));
  let cash=initial,currentDay="",dayStart=initial,peak=initial,dayStopped=false;
  const positions=new Map<string,SimTrade>(),orders=new Map<string,Order>(),latest=new Map<string,Bar>(),lastQuotes=new Map<string,Quote>();
  const unsettled:{date:string;amount:number}[]=[];
  const usedCapacity=new Map<string,number>();
  const reject=(reason:string)=>{out.rejected[reason]=(out.rejected[reason]??0)+1;};
  const fee=(qty:number)=>Math.max(base.minimumFee,qty*base.feePerShare)*multiplier;
  const slip=(price:number)=>Math.max(base.minimumSlippage,price*base.slippageFraction)*multiplier;
  const equity=()=>cash+unsettled.reduce((s,v)=>s+v.amount,0)+[...positions.values()].reduce((s,p)=>s+p.remaining*p.lastPrice,0);
  const markRisk=()=>{out.equity=equity();peak=Math.max(peak,out.equity);out.maxDrawdownPct=Math.max(out.maxDrawdownPct,(peak-out.equity)/peak*100);if(out.equity<=dayStart*(1-base.dailyLossFraction))dayStopped=true;};
  function saveDay() {
    if(!currentDay)return;markRisk();
    out.days.push({date:currentDay,equity:out.equity,net:out.equity-dayStart,returnPct:(out.equity/dayStart-1)*100,entries:out.trades.filter(t=>eastern(t.entryTime).date===currentDay).length,closed:out.trades.filter(t=>t.exitTime&&eastern(t.exitTime).date===currentDay).length,drawdownPct:(peak-out.equity)/peak*100});
  }
  function sell(position:SimTrade,qty:number,price:number,time:number,eventId:string,reason:string) {
    qty=Math.min(qty,position.remaining); if(qty<1)return;
    const cost=fee(qty),gross=(price-position.entry)*qty;position.remaining-=qty;position.fees+=cost;position.gross+=gross;position.net+=gross-cost;
    position.lastPrice=price;position.markTime=time;out.fees+=cost;
    const next=sessions.find(d=>d>eastern(time).date)??"9999-12-31";unsettled.push({date:next,amount:price*qty-cost});
    out.executions.push({id:digest([position.id,eventId,time,position.remaining]),tradeId:position.id,symbol:position.symbol,eventId,time,side:"sell",price,qty,fee:cost,reason,precision});
    if(!position.remaining){position.status="closed";position.exitTime=time;position.exitReason=reason;position.r=position.risk>0?position.net/position.risk:null;positions.delete(position.symbol);}
    markRisk();
  }
  for(const a of actions) {
    const day=eastern(a.time).date;if(day<sessions[0]||day>sessions.at(-1)!)continue;
    if(day!==currentDay) {
      saveDay();currentDay=day;
      for(let i=unsettled.length-1;i>=0;i--)if(unsettled[i].date<=day){cash+=unsettled[i].amount;unsettled.splice(i,1);}
      dayStart=equity();dayStopped=false;
    }
    for(const [symbol,o] of orders)if(o.event.payload.event==="entry"&&a.time>o.expires){reject("entry_expired");orders.delete(symbol);}
    if(a.kind==="close") {
      latest.set(a.symbol,a.bar!);const p=positions.get(a.symbol);
      if(p) {
        const b=a.bar!;p.lastPrice=b.c;p.markTime=a.time;
        // OHLC excursion is approximate; never use a bar that began before the fill.
        if(b.t>=p.entryTime){p.mfe=Math.max(p.mfe,(b.h/p.entry-1)*100);p.mae=Math.min(p.mae,(b.l/p.entry-1)*100);}
      }
      markRisk();continue;
    }
    if(a.kind==="event") {
      const e=a.event!,p=e.payload,existing=positions.get(a.symbol);
      if(p.event==="entry") {
        if(e.source==="tv"&&e.observedAt!==null&&(e.observedAt-p.signalTime>appConfig.intraday.maxSignalAgeMs||e.observedAt<p.signalTime-appConfig.intraday.maxFutureSkewMs)){reject("stale_or_future_tv");continue;}
        if(existing||orders.has(a.symbol)){reject("already_holding_or_pending");continue;}
        if(positions.size+[...orders.values()].filter(o=>o.event.payload.event==="entry").length>=base.maxPositions){reject("position_limit");continue;}
        const available=cash-[...orders.values()].reduce((s,o)=>s+o.reserved,0);
        const reserved=Math.max(0,Math.min(available,equity()*base.maxPositionFraction+base.minimumFee*multiplier));
        if(reserved<=base.minimumFee*multiplier){reject("cash_or_size_limit");continue;}
        const ready=precision==="bars"?Math.ceil((a.time+latency)/60000)*60000:a.time+latency;
        orders.set(a.symbol,{event:e,ready,expires:ready+base.entryExpiryMs,limit:null,lastLimitAt:0,reserved,remainingTarget:Infinity});
      } else if(existing&&existing.id===e.tradeId) {
        // Exits supersede outstanding partial orders; partial is emitted once by the signal model.
        orders.set(a.symbol,{event:e,ready:a.time+latency,expires:Infinity,limit:null,lastLimitAt:0,reserved:0,remainingTarget:p.event==="partial"?Math.max(1,Math.floor(existing.remaining/2)):existing.remaining});
      } else {
        if(orders.get(a.symbol)?.event.tradeId===e.tradeId)orders.delete(a.symbol);
        reject("no_simulated_entry");
      }
      continue;
    }
    if(a.quote){lastQuotes.set(a.symbol,a.quote);const p=positions.get(a.symbol);if(p&&a.quote.bid>0&&a.quote.ask>=a.quote.bid){p.lastPrice=a.quote.bid;p.markTime=a.time;markRisk();}}
    if(precision==="bars"&&a.kind!=="open"||precision==="quotes"&&a.kind!=="quote")continue;
    const order=orders.get(a.symbol);if(!order||a.time<order.ready)continue;
    const e=order.event,payload=e.payload,buy=payload.event==="entry",prior=latest.get(a.symbol),q=lastQuotes.get(a.symbol);
    const ref=precision==="bars"?a.bar!.o:buy?q?.ask:q?.bid;
    if(ref===undefined||ref<=0||precision==="quotes"&&(!q||q.bid<=0||q.ask<q.bid||a.time-q.t>base.quoteMaxAgeMs)){reject("invalid_quote");continue;}
    if(buy&&precision==="quotes"&&(q!.ask-q!.bid)/((q!.ask+q!.bid)/2)>base.maxSpreadFraction){reject("spread_too_wide");continue;}
    if(precision==="quotes"&&order.limit===null) {
      // Price protection is anchored to information at or before ready, not a later better quote.
      const history=options.quotes?.get(a.symbol)??[];let lo=0,hi=history.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(history[mid].t<=order.ready)lo=mid+1;else hi=mid;}
      const anchor=history[lo-1];
      if(buy&&(!anchor||order.ready-anchor.t>base.quoteMaxAgeMs||anchor.ask<=0)){reject("no_quote_at_order_time");orders.delete(a.symbol);continue;}
      const anchorPrice=buy?anchor!.ask:ref;
      order.limit=buy?anchorPrice+Math.max(.01,anchorPrice*base.limitProtection):anchorPrice-Math.max(.01,anchorPrice*base.limitProtection);order.lastLimitAt=a.time;
    }
    if(!buy&&precision==="quotes"&&a.time-order.lastLimitAt>=5000){order.limit=ref-Math.max(.01,ref*base.limitProtection);order.lastLimitAt=a.time;}
    const price=Math.max(.0001,ref+(buy?1:-1)*slip(ref));
    if(order.limit!==null&&(buy?price>order.limit:price<order.limit)){reject("limit_not_marketable");continue;}
    const capacityKey=`${a.symbol}/${prior?.t}`;
    let capacity=prior&&a.time-prior.t<=120000?Math.max(0,Math.floor(prior.v*base.participation)-(usedCapacity.get(capacityKey)??0)):0;
    if(precision==="quotes")capacity=Math.min(capacity,Math.floor(buy?q!.askSize:q!.bidSize));
    if(capacity<1){reject("insufficient_visible_capacity");continue;}
    if(buy) {
      markRisk();
      if(dayStopped){reject("daily_loss_stop");orders.delete(a.symbol);continue;}
      if(positions.size>=base.maxPositions){reject("position_limit");orders.delete(a.symbol);continue;}
      if(eastern(a.time).minute>=570||eastern(a.time).date!==eastern(payload.signalTime).date){reject("entry_outside_session");orders.delete(a.symbol);continue;}
      const stop=payload.stop!;if(price<=stop){reject("entry_below_stop");orders.delete(a.symbol);continue;}
      const spendable=cash-[...orders.values()].filter(o=>o!==order).reduce((s,o)=>s+o.reserved,0);
      const qty=Math.floor(Math.min(out.equity*base.riskFraction/(price-stop),out.equity*base.maxPositionFraction/price,(spendable-base.minimumFee*multiplier)/(price+base.feePerShare*multiplier),capacity));
      if(qty<1){reject("cash_or_size_limit");orders.delete(a.symbol);continue;}
      const cost=fee(qty);cash-=qty*price+cost;out.fees+=cost;
      usedCapacity.set(capacityKey,(usedCapacity.get(capacityKey)??0)+qty);
      const position:SimTrade={id:e.tradeId!,symbol:a.symbol,kind:payload.reason,entryTime:a.time,exitTime:null,entry:price,stop,qty,remaining:qty,fees:cost,net:-cost,gross:0,risk:(price-stop)*qty,r:null,mfe:0,mae:0,lastPrice:precision==="quotes"?q!.bid:ref,markTime:a.time,status:"open",exitReason:null};
      positions.set(a.symbol,position);out.trades.push(position);orders.delete(a.symbol);
      out.executions.push({id:digest([e.id,a.time]),tradeId:position.id,symbol:a.symbol,eventId:e.id,time:a.time,side:"buy",price,qty,fee:cost,reason:payload.reason,precision});
    } else {
      const position=positions.get(a.symbol);if(!position||position.id!==e.tradeId){orders.delete(a.symbol);continue;}
      const requested=Math.min(order.remainingTarget,position.remaining);
      const qty=Math.min(requested,capacity);usedCapacity.set(capacityKey,(usedCapacity.get(capacityKey)??0)+qty);sell(position,qty,price,a.time,e.id,payload.reason);
      order.remainingTarget-=qty;
      if(order.remainingTarget<=0||!position.remaining)orders.delete(a.symbol);
    }
    markRisk();
  }
  saveDay();
  for(const order of orders.values())reject(order.event.payload.event==="entry"?"unfilled_entry":"unfilled_exit");
  const closed=out.trades.filter(t=>t.status==="closed"),wins=closed.filter(t=>t.net>0),losses=closed.filter(t=>t.net<0);
  out.closed=closed.length;out.open=positions.size;out.wins=wins.length;out.net=out.equity-initial;out.returnPct=out.net/initial*100;
  out.winRate=closed.length?wins.length/closed.length*100:null;out.averageWin=wins.length?wins.reduce((s,t)=>s+t.net,0)/wins.length:null;out.averageLoss=losses.length?losses.reduce((s,t)=>s+t.net,0)/losses.length:null;
  out.expectancy=closed.length?closed.reduce((s,t)=>s+t.net,0)/closed.length:null;out.profitFactor=losses.length?wins.reduce((s,t)=>s+t.net,0)/-losses.reduce((s,t)=>s+t.net,0):null;
  let streak=0;for(const t of [...closed].sort((a,b)=>a.exitTime!-b.exitTime!)){streak=t.net<0?streak+1:0;out.consecutiveLosses=Math.max(out.consecutiveLosses,streak);}
  out.warnings.push("过滤计数是执行尝试次数，同一订单可能因多条报价被多次拒绝；部分成交按目标数量继续排队。分钟延迟取整会使 2 秒与 5 秒情景落到相同开盘。");
  if(out.open)out.warnings.push(`${out.open} 笔仍未平仓，权益使用最后可见价格估值；不能当作全部实现收益。`);
  if(precision==="quotes")out.warnings.push("报价数量为供应商原始单位；首版按不放大的可见数量限制成交。部分退出按每次执行收最低费用，属于保守成本估计。");
  // Include zero-signal sessions so the graph never silently drops flat days.
  let carried=initial,carriedDrawdown=0;out.days=sessions.map(date=>{const row=out.days.find(d=>d.date===date);if(row){carried=row.equity;carriedDrawdown=row.drawdownPct;return row;}return {date,equity:carried,returnPct:0,net:0,entries:0,closed:0,drawdownPct:carriedDrawdown};});
  return out;
}
