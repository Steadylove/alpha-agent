import { MPR_SYMBOLS } from "@/lib/scoring/mpr";
import { readSnapshot } from "@/lib/vps/snapshot";

/** MacroPhaseState 落库的字段子集，页面只需要这些。 */
export type MacroPhaseSnapshot = {
  date: string;
  pathId: number;
  fsmState: number;
  marketRiskScore: number;
  prob5dDown: number;
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  f5: number;
  rawTerm: number;
  rawCred: number;
  domVol: number;
  domCred: number;
  domSpot: number;
  spyDamage: number;
  leadGap: number;
  leadPersist: number;
  leadQuality: number;
  transVel: number;
  /** 传导深度 0~3，路径判定的中间量 */
  transDepth: number;
  couplingRatio: number;
  /** 三域 σ 分级：0 平静 / 1 异动 / 2 极端 */
  sigmaVol: number;
  sigmaCred: number;
  sigmaSpot: number;
};

/** 时间轴用的一天：MPR 快照加上当日 SPY 收盘，便于看路径判定是否滞后于价格。 */
export type MprHistoryPoint = MacroPhaseSnapshot & { spyClose: number | null };

export type MprData = {
  latest: MacroPhaseSnapshot | null;
  /** 近端历史，最新的在最后。 */
  history: MprHistoryPoint[];
  /** 宏观日线缺失的标的，非空时说明还没跑 npm run backfill:macro。 */
  missingSymbols: string[];
};

/** MPR 快照原先只在库里；运行时不再读库，页面为空。 */
export async function getMprData(): Promise<MprData> {
  return (
    (await readSnapshot<MprData>("mpr")) ?? {
      latest: null,
      history: [],
      missingSymbols: [...MPR_SYMBOLS],
    }
  );
}
