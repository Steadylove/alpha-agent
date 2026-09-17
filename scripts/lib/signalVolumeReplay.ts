import assert from "node:assert/strict";
import { PROFILE_BINS, VOLUME_WINDOW, type VolumeBar, type VolumeSnapshot } from "../../src/lib/signals/volumeFactors";

export type MinuteBar = { t: string; o: number; h: number; l: number; c: number; v: number };
export type MinuteSample = MinuteBar & { time: number; delta: number };
export type ParentVolume = { bar: VolumeBar; samples: MinuteSample[]; referenceChecked?: boolean };
const nyClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** 与 Pine 的常规时段 1m 方向规则一致；明确剔除信号之后和盘前盘后数据。 */
export function prepareMinutes(raw: MinuteBar[], cutoff: number): Map<number, MinuteSample> {
  const out = new Map<number, MinuteSample>();
  let direction = 0, previousClose: number | undefined;
  for (const b of raw.map(b => ({ ...b, time: Date.parse(b.t) })).sort((a,b) => a.time-b.time)) {
    assert(Number.isSafeInteger(b.time), "无效分钟时间");
    if (b.time + 60_000 > cutoff) continue;
    const [hour, minute] = nyClock.format(b.time).split(":").map(Number);
    const clock = hour*60+minute;
    if (clock < 570 || clock >= 960) continue;
    assert(!out.has(b.time), "分钟行情重复");
    assert(b.time % 60_000 === 0 && [b.o,b.h,b.l,b.c].every(n => Number.isFinite(n) && n > 0) &&
      Number.isFinite(b.v) && b.v >= 0 && b.h >= Math.max(b.o,b.l,b.c) && b.l <= Math.min(b.o,b.h,b.c), "分钟量价无效");
    direction = b.c > b.o ? 1 : b.c < b.o ? -1 : previousClose != null && b.c > previousClose ? 1 :
      previousClose != null && b.c < previousClose ? -1 : direction;
    out.set(b.time, { ...b, delta: b.v * direction });
    previousClose = b.c;
  }
  return out;
}

/** 预览采用完整分钟网格重新聚合父级 OHLCV，不能拿自己的汇总量冒充旧父级量的覆盖率。 */
export function aggregateMinuteWindow(start: number, end: number, minutes: Map<number, MinuteSample>, requireComplete = true): ParentVolume {
  assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start && end-start <= 86400000 && (end-start)%60_000 === 0, "父级时间范围无效");
  const samples: MinuteSample[] = [];
  for (let time = start; time < end; time += 60_000) {
    const m = minutes.get(time);
    if (requireComplete) assert(m, `缺少 ${new Date(time).toISOString()} 分钟行情，停止生成完整指标`);
    if (m) samples.push(m);
  }
  const volume = samples.reduce((sum,b) => sum+b.v,0);
  assert(volume > 0, "窗口没有有效成交量");
  return { samples, bar: [start,end,samples[0].o,Math.max(...samples.map(b=>b.h)),Math.min(...samples.map(b=>b.l)),
    samples.at(-1)!.c,volume,samples.reduce((sum,b)=>sum+b.delta,0),volume,samples[0].time,samples.at(-1)!.time+60000] };
}

/** 用独立下载的 30m 聚合量验证分钟空档；不把未返回的分钟伪造成零量 K 线。 */
export function reconcileParent(parent: ParentVolume, references: MinuteBar[]): ParentVolume {
  const [start,end] = parent.bar;
  const rows = references.filter(b=>Date.parse(b.t)>=start && Date.parse(b.t)+1800000<=end).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  assert.equal(rows.length,(end-start)/1800000,"独立 30 分钟参照不足");
  rows.forEach((b,i)=>{
    assert.equal(Date.parse(b.t),start+i*1800000,"独立 30 分钟参照有空档或重复");
    assert([b.o,b.h,b.l,b.c].every(n=>Number.isFinite(n)&&n>0)&&Number.isFinite(b.v)&&b.v>=0&&
      b.h>=Math.max(b.o,b.l,b.c)&&b.l<=Math.min(b.o,b.h,b.c),"独立参照量价无效");
  });
  const volume = rows.reduce((sum,b)=>sum+b.v,0), coverage = parent.bar[8]/volume;
  assert(volume>0 && coverage>=.98 && coverage<=1.02,"分钟成交量与独立 30 分钟参照不一致");
  const bar: VolumeBar = [...parent.bar];
  [bar[2],bar[3],bar[4],bar[5],bar[6]] = [rows[0].o,Math.max(...rows.map(b=>b.h)),Math.min(...rows.map(b=>b.l)),rows.at(-1)!.c,volume];
  return {...parent,bar,referenceChecked:true};
}

export function minuteVolumeSnapshot(parents: ParentVolume[]): VolumeSnapshot {
  const window = parents.slice(-VOLUME_WINDOW);
  assert.equal(window.length,VOLUME_WINDOW,"分钟快照需要 20 根父级 K 线");
  window.forEach(p=>assert(p.referenceChecked || p.samples.length===(p.bar[1]-p.bar[0])/60000,"分钟空档未经独立参照校验"));
  const low = Math.min(...window.map(p=>p.bar[4])), high = Math.max(...window.map(p=>p.bar[3]));
  assert(high > low, "窗口价格无变化，无法构建成交分布");
  const volumes = Array<number>(PROFILE_BINS).fill(0);
  let samples = 0;
  for (const parent of window) for (const m of parent.samples) {
    const index = Math.max(0,Math.min(PROFILE_BINS-1,Math.floor(((m.h+m.l+m.c)/3-low)/(high-low)*PROFILE_BINS)));
    volumes[index] += m.v;
    samples++;
  }
  return { version:1,method:"ltf-direction-v1",timeframe:"1",bars:window.map(p=>p.bar),
    profile:{method:"ltf-hlc3-v1",low,high,volumes,samples} };
}
