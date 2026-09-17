import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { profileValueArea, volumeFactorsOf } from "@/lib/signals/volumeFactors";
import { qualityGrade } from "@/lib/signals/assessment";
import { signalBars, volumeFixture } from "./fixtures/signalVolume";

const time=signalBars.at(-1)![1];
describe("分钟量价估算", () => {
  it("从 POC 邻接扩展价值区，保留至少 70% 成交量而非价格分位数", () => {
    expect(profileValueArea([5,20,50,20,5])).toEqual({poc:2,lo:1,hi:2,total:100,coverage:.7});
    expect(profileValueArea([0,0,0])).toBeUndefined();
    expect(profileValueArea([1,-1,2])).toBeUndefined();
  });
  it("输出可复核 POC、价值区和低成交量区，不当作真实盘口深度", () => {
    const r=volumeFactorsOf(volumeFixture(),time,102);
    expect(r.profile).toMatchObject({points:15,poc:101.9375,val:101.875,vah:102,lowVolume:false,valueAreaCoverage:.7});
    expect(r.profile.lowVolumeZones).toEqual([{low:99,high:101.875},{low:102.125,high:103}]);
    expect(r.cvd.points).toBe(20);
    expect(r.cvd.deltaRatio).toBe(.8);
    expect(r.cvd.reason).toContain("估算");
  });
  it("价格创新低而 CVD 抬升识别底背离；顶背离限制多头分数", () => {
    const bull=volumeFixture(); bull.bars[4][4]=98; bull.bars[15][4]=97;
    expect(volumeFactorsOf(bull,time,102).cvd.divergence).toBe("bullish");
    const bear=volumeFixture(); bear.bars.forEach(b=>b[7]=-800); bear.bars[4][3]=104; bear.bars[15][3]=105;
    const result=volumeFactorsOf(bear,time,102);
    expect(result.cvd.divergence).toBe("bearish");
    expect(result.cvd.points).toBeLessThanOrEqual(6);
  });
  it("未来/过期/乱序/不足覆盖/夸大净量都不评分，也不从旧 K 线补值", () => {
    for(const change of [
      (s:ReturnType<typeof volumeFixture>)=>{s.bars.at(-1)![1]++;},
      (s:ReturnType<typeof volumeFixture>)=>{s.bars[0][10]=time+1;},
      (s:ReturnType<typeof volumeFixture>)=>{s.bars.reverse();},
      (s:ReturnType<typeof volumeFixture>)=>{s.bars.pop();},
      (s:ReturnType<typeof volumeFixture>)=>{s.bars[0][8]=970;},
      (s:ReturnType<typeof volumeFixture>)=>{s.bars[0][7]=1001;},
      (s:ReturnType<typeof volumeFixture>)=>{s.bars.at(-1)![5]=101;},
    ]) {
      const s=volumeFixture();change(s);
      expect(volumeFactorsOf(s,time,102).cvd.points).toBeNull();
      expect(volumeFactorsOf(s,time,102).profile.points).toBeNull();
    }
    expect(volumeFactorsOf(volumeFixture(),time+1,102).cvd.points).toBeNull();
  });
  it("分布总量不一致时只缺该维，保留有效 CVD", () => {
    const s=volumeFixture(); s.profile.volumes[0]+=200;
    const r=volumeFactorsOf(s,time,102);
    expect(r.cvd.points).not.toBeNull();
    expect(r.profile.points).toBeNull();
  });
  it("80/65/50 的等级边界固定，缺数据不虚构满分评级", () => {
    expect([80,79.9,65,64.9,50,49.9].map(n=>qualityGrade(n))).toEqual(["优秀","良好","良好","一般","一般","偏弱"]);
    expect(qualityGrade(54,55)).toBe("资料未齐");
  });
  it("三份 Pine 同步同一份采集逻辑，买卖点均携带新增快照", () => {
    const sources=["tradingview-signal.pine","tradingview-signal-2h.pine","tradingview-signal-4h.pine"].map(n=>readFileSync(`docs/${n}`,"utf8"));
    const block=(s:string)=>s.slice(s.indexOf("// ───────────────────────── 五因子 V2："),s.indexOf("// ───────────────────────── 五因子 V2 快照结束"));
    expect(block(sources[0])).toBe(block(sources[1]));expect(block(sources[1])).toBe(block(sources[2]));
    sources.forEach(s=>{
      expect(s.match(/\"volumeSnapshot\":/g)).toHaveLength(2);
      expect(s).toContain('ignore_invalid_timeframe = true');
      expect(s).toContain('if barstate.isconfirmed');
    });
  });
});
