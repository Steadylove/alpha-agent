import type { VolumeSnapshot } from "@/lib/signals/volumeFactors";

/** 明确为合成数据；测试校验/评分，不冒充实盘历史 CVD。 */
export const SIGNAL_BAR_MS = 4*60*60*1000;
export const SIGNAL_START = Date.UTC(2026,8,1,13,30);
export const signalBars = Array.from({length:30},(_,i) => [SIGNAL_START+i*SIGNAL_BAR_MS, SIGNAL_START+(i+1)*SIGNAL_BAR_MS,
  100,103,99,102,97+i/10,96.8+i/10,94+i/20,93.8+i/20]);

export function volumeFixture(): VolumeSnapshot {
  return {version:1,method:"ltf-direction-v1",timeframe:"1",
    bars:signalBars.slice(-20).map((b) => [b[0],b[1],b[2],b[3],b[4],b[5],1000,800,1000,b[0],b[1]]),
    profile:{method:"ltf-hlc3-v1",low:99,high:103,samples:4800,
      volumes:Array.from({length:32},(_,i) => i===23 ? 14000 : i===24 ? 6000 : 0)}};
}
