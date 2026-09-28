import { describe, expect, it, vi, afterEach } from "vitest";
import { Cooldown, Rma, ResonanceIndicators, replaySymbol, splitDiscontinuities } from "@/lib/intraday/resonance";
import { eastern, easternMidnight } from "@/lib/intraday/researchData";
import { simulate } from "@/lib/intraday/simulation";
import { signalId, tradeId, type IntradaySignal } from "@/lib/intraday/protocol";
import { defaultPushRoutes } from "@/lib/notifications/pushRoutesLogic";
import type { Bar, Quote, ResearchEvent, SymbolData } from "@/lib/intraday/researchTypes";

const start=Date.parse("2026-09-10T12:01:00Z"),symbol="NASDAQ:TEST",sessions=["2026-09-10","2026-09-11"];
const bar=(t:number,price=5,volume=10000):Bar=>({t,o:price,c:price,h:price+.1,l:price-.1,v:volume});
function event(at:number,kind:IntradaySignal["event"]="entry",extra:Partial<IntradaySignal>={}):ResearchEvent {
  const payload:IntradaySignal={protocol:"intraday-v1",strategy:"resonance-long",scriptVersion:"test",strategyKey:"fixture",symbol,tf:"1",event:kind,reason:kind==="entry"?"premium_resonance":kind==="partial"?"resonance_reduce":"session_end",barTime:at-60000,signalTime:at,entrySignalTime:start,price:5,entryPrice:5,stop:4.5,metrics:{},parameters:{},...extra};
  return {id:signalId(payload),tradeId:tradeId(payload),payload,source:"offline",observedAt:null};
}
const wave=(i:number)=>{const b=bar(start-650*60000+i*60000,5+Math.sin(i*.07)*.8,10000);return {...b,h:b.c+.005,l:b.c-.005};};
const bars=()=>new Map([[symbol,[bar(start-60000),bar(start),bar(start+60000),bar(start+120000,6),bar(start+180000,6),bar(start+240000,6)]]]);
const quote=(t:number,bid=4.99,ask=5,size=1000):Quote=>({t,bid,ask,bidSize:size,askSize:size});

afterEach(()=>vi.restoreAllMocks());
describe("共振公式和时间口径",()=>{
  it("RMA 用 SMA 播种，之后采用 Wilder 递推",()=>{const r=new Rma(3);expect(r.next(3)).toBeNaN();expect(r.next(6)).toBeNaN();expect(r.next(9)).toBe(6);expect(r.next(12)).toBe(8);expect(r.next(NaN)).toBe(8);});
  it("FILTER 只由发出的信号起算，随后完整屏蔽四根",()=>{const f=new Cooldown(4);expect(Array.from({length:11},(_,i)=>f.next(true,i))).toEqual([true,false,false,false,false,true,false,false,false,false,true]);});
  it("无价格振幅时严格使用 WR 原公式，不产生错误的超卖",()=>{const indicator=new ResonanceIndicators();let last;for(let i=0;i<600;i++)last=indicator.next({t:i*60000,o:5,h:5,l:5,c:5,v:10});expect(last).toMatchObject({fund:100,main:100,long:100,cleanBuy:false,trend:0,powerline:0});});
  it("历史计算满足前缀不变性：加入未来数据不修改已有信号",()=>{
    const data:SymbolData={symbol,bars:Array.from({length:800},(_,i)=>wave(i)),daily:[],floats:[],splitFactors:{}};
    const first=replaySymbol({...data,bars:data.bars.slice(0,720)},sessions[0],sessions[1],"formula-only",500);
    const full=replaySymbol(data,sessions[0],sessions[1],"formula-only",500);
    expect(first.events.length).toBeGreaterThan(0);
    expect(full.events.filter(e=>e.payload.signalTime<=data.bars[719].t+60000)).toEqual(first.events);
    expect(replaySymbol(data,sessions[0],sessions[1],"strict",500).events).toEqual([]);
  });
  it("Float 只能在公布后使用，日量只使用前一日及更早数据",()=>{
    const data:SymbolData={symbol,bars:Array.from({length:850},(_,i)=>wave(i)),daily:Array.from({length:60},(_,i)=>bar(Date.parse("2026-07-01T20:00:00Z")+i*86400000,2,100)),floats:[{shares:1000,availableAt:start+20*60000}],splitFactors:{}};
    const before=replaySymbol(data,sessions[0],sessions[1],"strict");
    expect(before.events.length).toBeGreaterThan(0);expect(before.events.every(e=>e.payload.signalTime>=data.floats[0].availableAt)).toBe(true);
    const future=replaySymbol({...data,daily:[...data.daily,bar(Date.parse("2026-09-10T20:00:00Z"),5000,1e12)]},sessions[0],sessions[1],"strict");
    expect(future.events).toEqual(before.events);
  });
  it("拆并股线索不会静默变成巨额收益",()=>{const data:SymbolData={symbol,bars:[],daily:[],floats:[],splitFactors:{"2026-09-08":.1,"2026-09-09":1}};expect(splitDiscontinuities(data)).toEqual(["2026-09-09"]);expect(replaySymbol(data,sessions[0],sessions[1],"formula-only").events).toEqual([]);});
  it("美东夏令时与冬令时均保持 04:00 开始",()=>{expect(eastern(Date.parse("2026-09-10T08:00Z")).minute).toBe(240);expect(eastern(Date.parse("2026-12-10T09:00Z")).minute).toBe(240);});
  it("分钟采集以美东日界截止，冬令时不漏掉盘后最后一小时",()=>{expect(new Date(easternMidnight("2026-12-11")).toISOString()).toBe("2026-12-11T05:00:00.000Z");expect(new Date(easternMidnight("2026-09-11")).toISOString()).toBe("2026-09-11T04:00:00.000Z");});
});

describe("有资金限制的模拟成交",()=>{
  it("不按信号收盘立即成交；2秒延迟在分钟版取整，扣除双边成本",()=>{
    const result=simulate([event(start),event(start+120000,"exit")],bars(),sessions);
    expect(result.closed).toBe(1);expect(result.trades[0].entryTime).toBe(start+60000);expect(result.trades[0].entry).toBeCloseTo(5.01);
    expect(result.trades[0].exitTime).toBe(start+180000);expect(result.fees).toBe(2);expect(result.net).toBeCloseTo((5.99-5.01)*49-2);
    expect(result.days).toHaveLength(2);
  });
  it("报价版不使用 ready 之后的报价作为下单参考",()=>{
    const quotes=new Map([[symbol,[quote(start+3000),quote(start+4000)]]]);
    const result=simulate([event(start)],bars(),sessions,{precision:"quotes",quotes});
    expect(result.trades).toHaveLength(0);expect(result.rejected.no_quote_at_order_time).toBe(1);
  });
  it("报价价差太大拒绝开仓；已知报价到期后也不追价",()=>{
    const quotes=new Map([[symbol,[quote(start),quote(start+3000,4,5),quote(start+40000)]]]);
    const result=simulate([event(start)],bars(),sessions,{precision:"quotes",quotes});
    expect(result.trades).toHaveLength(0);expect(result.rejected.spread_too_wide).toBe(1);expect(result.rejected.entry_expired).toBe(1);
  });
  it("分钟止损事件之前不从完整分钟低点预知退出",()=>{
    const m=bars();m.get(symbol)![2].l=4;
    const result=simulate([event(start),event(start+120000,"stop")],m,sessions);
    expect(result.executions[1].time).toBeGreaterThan(start+120000);
    expect(result.executions[1].reason).toBe("session_end");
  });
  it("部分退出受到流动性限制后继续补到原始目标，不反复减半",()=>{
    const quotes=new Map([[symbol,[quote(start),quote(start+3000),quote(start+60000,5.49,5.50,5),...Array.from({length:6},(_,i)=>quote(start+63000+i*1000,5.49,5.50,5)),quote(start+120000,5.99,6),quote(start+123000,5.99,6)]]]);
    const result=simulate([event(start),event(start+60000,"partial"),event(start+120000,"exit")],bars(),sessions,{precision:"quotes",quotes});
    expect(result.closed).toBe(1);expect(result.trades[0].qty).toBe(49);
    expect(result.executions.filter(e=>e.reason==="resonance_reduce").reduce((sum,e)=>sum+e.qty,0)).toBe(24);
    expect(result.executions.filter(e=>e.side==="sell").reduce((sum,e)=>sum+e.qty,0)).toBe(49);
  });
  it("过期 TV 消息可以研究存档，但不能按历史理想时刻成交",()=>{
    const delayed={...event(start),source:"tv" as const,observedAt:start+121000};
    const result=simulate([delayed],bars(),sessions);expect(result.trades).toHaveLength(0);expect(result.rejected.stale_or_future_tv).toBe(1);
  });
  it("当日卖出资金不可重复购买，下个交易日才解冻",()=>{
    const events:ResearchEvent[]=[],data:Bar[]=[];
    for(let i=0;i<7;i++) {
      const t=i<6?start+i*600000:start+86400000;
      events.push(event(t,"entry",{entrySignalTime:t,stop:4.999}),event(t+120000,"exit",{entrySignalTime:t,stop:4.999}));
      for(let n=-1;n<5;n++)data.push(bar(t+n*60000,5,1e6));
    }
    const result=simulate(events,new Map([[symbol,data]]),sessions);
    const dayOneBuys=result.executions.filter(e=>e.side==="buy"&&eastern(e.time).date===sessions[0]);
    expect(dayOneBuys.reduce((sum,e)=>sum+e.qty*e.price+e.fee,0)).toBeLessThanOrEqual(10000.000001);
    expect(dayOneBuys.at(-1)!.qty).toBeLessThan(dayOneBuys[0].qty);
    expect(result.executions.find(e=>e.side==="buy"&&eastern(e.time).date===sessions[1])?.qty).toBeGreaterThan(300);
  });
  it("没有报价不能降级成分钟成交，没有入场不能生成卖出收益",()=>{
    expect(simulate([event(start),event(start+120000,"exit")],bars(),sessions,{precision:"quotes"}).trades).toHaveLength(0);
    expect(simulate([event(start+120000,"exit")],bars(),sessions).net).toBe(0);
  });
  it("新日内路线默认静默，其他已有路线不改变",()=>{const routes=defaultPushRoutes();expect(routes.routes["signal-intraday"].enabled).toBe(false);expect(routes.routes.gex.enabled).toBe(true);});
});
