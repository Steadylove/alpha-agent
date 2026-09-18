import { describe, expect, it } from "vitest";
import { latestRpsSession, signalRpsFromPanels } from "@/lib/backtest/buildSignalRps";
import type { PanelBars } from "@/lib/backtest/panel";

const dates = Array.from({length:254},(_,i)=>new Date(Date.UTC(2025,11,8+i)).toISOString().slice(0,10));
const day=dates[252];
const panels:PanelBars[]=Array.from({length:500},(_,i)=>({ ticker:`S${i}`,dates,close:Float32Array.from(dates.map((_,d)=>100*(1+d*(i+1)/100000))),high:new Float32Array(254),low:new Float32Array(254),open:null,volume:null }));
const benchmark=panels.map(p=>p.ticker);
const calendar={from:dates[0],through:"2026-12-31",sessions:dates};
const now=new Date("2026-09-18T00:00:00Z");
describe("每日信号排名",()=>{
  it("尊重行情20分钟延迟及真实交易日历，不把收盘前的日线当成已完成",()=>{
    const cal={from:"2026-09-01",through:"2026-09-30",sessions:["2026-09-04","2026-09-08","2026-09-16","2026-09-17"]};
    expect(latestRpsSession(cal,new Date("2026-09-17T20:15:00Z"))).toBe("2026-09-16");
    expect(latestRpsSession(cal,new Date("2026-09-17T20:35:00Z"))).toBe("2026-09-17");
    expect(latestRpsSession(cal,new Date("2026-09-08T12:00:00Z"))).toBe("2026-09-04");
  });
  it("用当日标普价格分布生成最新日线排名，2H/4H不额外滞后",()=>{
    const r=signalRpsFromPanels(panels,benchmark,day,calendar,now);
    expect(r.count).toBe(500);expect(r.snapshot.timeframes['2h']!.S499).toEqual({rps:99,asOf:day});
    expect(r.snapshot.timeframes['2h']).toEqual(r.snapshot.timeframes['1d']);expect(r.snapshot.timeframes['4h']!.S0.rps).toBe(1);
  });
  it("信号日之后的极端价格不改变当日排名",()=>{
    const changed=panels.map(p=>({...p,close:Float32Array.from(p.close)}));changed.forEach(p=>p.close[253]=1e8);
    expect(signalRpsFromPanels(changed,benchmark,day,calendar,now)).toEqual(signalRpsFromPanels(panels,benchmark,day,calendar,now));
  });
  it("最新价格变化会改变分位切点；不复制旧标尺",()=>{
    const changed=panels.map(p=>({...p,close:Float32Array.from(p.close)}));changed.forEach(p=>p.close[252]*=1.1);
    expect(signalRpsFromPanels(changed,benchmark,day,calendar,now).cuts).not.toEqual(signalRpsFromPanels(panels,benchmark,day,calendar,now).cuts);
  });
  it("缺当日行情不回填，标普覆盖不足则拒绝整个快照",()=>{
    const missing=panels.map((p,i)=>i? p : {...p,dates:p.dates.filter(d=>d!==day)});
    const r=signalRpsFromPanels(missing,benchmark,day,calendar,now);expect(r.snapshot.timeframes['1d']!.S0).toBeUndefined();
    expect(()=>signalRpsFromPanels(panels.slice(20),benchmark,day,calendar,now)).toThrow(/样本不足/);
  });
});
