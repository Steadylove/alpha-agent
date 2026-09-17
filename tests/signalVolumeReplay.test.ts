import { describe, expect, it } from "vitest";
import { aggregateMinuteWindow, minuteVolumeSnapshot, prepareMinutes, reconcileParent, type MinuteBar } from "../scripts/lib/signalVolumeReplay";
import { volumeFactorsOf } from "@/lib/signals/volumeFactors";

const start = Date.UTC(2026,8,2,13,30);
const bar = (i:number, o=100, c=101, v=10): MinuteBar => ({t:new Date(start+i*60000).toISOString(),o,h:Math.max(o,c)+1,l:Math.min(o,c)-1,c,v});

describe("真实分钟回放",()=>{
  it("分钟方向采用实体、前收盘、继承方向三级规则",()=>{
    const minutes = prepareMinutes([bar(0),bar(1,100,100,20),bar(2,100,100,30),bar(3,101,101,40)],start+4*60000);
    expect([...minutes.values()].map(m=>m.delta)).toEqual([10,-20,-30,40]);
    expect(aggregateMinuteWindow(start,start+2*60000,minutes).bar).toEqual([
      start,start+2*60000,100,102,99,100,30,-10,30,start,start+2*60000,
    ]);
  });
  it("不接受重复或缺失分钟，不通过填价格或放宽覆盖来凑指标",()=>{
    expect(()=>prepareMinutes([bar(0),bar(0)],start+60000)).toThrow("重复");
    const minutes = prepareMinutes([bar(0),bar(2)],start+3*60000);
    expect(()=>aggregateMinuteWindow(start,start+3*60000,minutes)).toThrow("缺少");
    // 仅允许评分窗口以外的走势图保留源数据空档，不生成假的平盘蜡烛。
    expect(aggregateMinuteWindow(start,start+3*60000,minutes,false).samples).toHaveLength(2);
  });
  it("20 根父级同源聚合可得到两项指标，未来大额成交与盘前数据不参与",()=>{
    const raw = Array.from({length:40},(_,i)=>bar(i));
    const cutoff = start+40*60000;
    const minutes = prepareMinutes([...raw,bar(40,900,999,999999),bar(-1,800,900,999999)],cutoff);
    expect(minutes.size).toBe(40);
    const parents = Array.from({length:20},(_,i)=>aggregateMinuteWindow(start+i*120000,start+(i+1)*120000,minutes));
    const snapshot = minuteVolumeSnapshot(parents);
    expect(snapshot.profile.samples).toBe(40);
    expect(snapshot.profile.volumes.reduce((a,b)=>a+b,0)).toBe(400);
    expect(snapshot.profile.low).toBe(99);
    expect(snapshot.profile.high).toBe(102);
    const result = volumeFactorsOf(snapshot,cutoff,101);
    expect(result.cvd.points).not.toBeNull();
    expect(result.cvd.deltaRatio).toBe(1);
    expect(result.profile.points).not.toBeNull();
  });
  it("分钟空档只有通过独立 30m 成交量核对才可采用，不能靠自算总量绕过校验",()=>{
    const minutes = prepareMinutes(Array.from({length:30},(_,i)=>bar(i)).filter((_,i)=>i!==5),start+1800000);
    const parent = aggregateMinuteWindow(start,start+1800000,minutes,false);
    expect(parent.bar[8]).toBe(290);
    const accepted = reconcileParent(parent,[bar(0,100,101,290)]);
    expect(accepted.referenceChecked).toBe(true);
    expect(accepted.bar[6]).toBe(290);
    expect(()=>reconcileParent(parent,[bar(0,100,101,400)])).toThrow("不一致");
    expect(()=>reconcileParent(parent,[])).toThrow("参照不足");
  });
});
