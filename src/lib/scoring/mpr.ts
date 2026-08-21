import {
  emaSeries,
  highestSeries,
  lowestSeries,
  percentRankSeries,
  rocSeries,
  smaSeries,
} from "@/lib/scoring/series";

/**
 * MPR V2 宏观相变引擎。
 *
 * 移植自 TradingView Pine 指标「Market Phase Radar (MPR) [V2 状态拓扑对齐版]」。
 * 五力场 -> 三物理域 -> 几何耦合 -> 传导路径 -> 5 日下跌概率与系统风险分。
 *
 * 有状态：leadPersist 跨日递推，必须从序列起点连续计算，不能只喂最近 N 根。
 */

/** 单个交易日的对齐后输入。GLD 在 Pine 源码里声明但未被任何力场使用，故不需要。 */
export type MprInput = {
  date: string;
  spyClose: number;
  spyVolume: number;
  rspClose: number;
  tltClose: number;
  dxyClose: number;
  hygClose: number;
  ieiClose: number;
  vixClose: number;
  vix9dClose: number;
  vix3mClose: number;
};

export type MprParams = {
  /** ECDF 回溯窗口，Pine 默认 252 */
  calibLen: number;
  /** 背离观测周期，Pine 默认 5 */
  driftLen: number;
  /** 动量求导周期，Pine 默认 3 */
  dynLen: number;
  /** 持续性衰减常数，Pine 默认 5.0 */
  tauPersist: number;
};

export const MPR_DEFAULTS: MprParams = {
  calibLen: 252,
  driftLen: 5,
  dynLen: 3,
  tauPersist: 5.0,
};

export type MprPathId = 0 | 1 | 2 | 3 | 4;
export type MprSigma = 0 | 1 | 2;

export type MprDay = {
  date: string;
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
  sigmaVol: MprSigma;
  sigmaCred: MprSigma;
  sigmaSpot: MprSigma;
  couplingRatio: number;
  spyDamage: number;
  leadGap: number;
  leadPersist: number;
  leadQuality: number;
  pathId: MprPathId;
  transDepth: number;
  fsmState: 0 | 1 | 2 | 3;
  prob5dDown: number;
  marketRiskScore: number;
  transVel: number;
};

/**
 * 镜像 Pine 的 f_rolling_ecdf：nz(ta.percentrank(nz(src, 0.0), len), 50.0)。
 * 两次 nz 的填充值不同（源填 0、结果填 50），顺序不可颠倒。
 */
export function rollingEcdf(raw: (number | null)[], length: number): number[] {
  const filled = raw.map((v) => (v == null || !Number.isFinite(v) ? 0 : v));
  return percentRankSeries(filled, length).map((v) => (v == null ? 50 : v));
}

/** 对齐用的最小 bar 结构，避免调用方被迫构造完整 DailyBar。 */
export type AlignBar = { date: string; close: number; volume: number };

export const MPR_SYMBOLS = [
  "SPY",
  "RSP",
  "TLT",
  "DXY",
  "HYG",
  "IEI",
  "VIX",
  "VIX9D",
  "VIX3M",
] as const;

export type MprSymbol = (typeof MPR_SYMBOLS)[number];

/**
 * 把 9 个标的的日线内连接到共同交易日。
 * DXY 走 ICE 日历，与美股假期不完全重合，必须对齐后才能算跨资产力场。
 */
export function alignMprInputs(bySymbol: Record<MprSymbol, AlignBar[]>): MprInput[] {
  const maps = new Map<MprSymbol, Map<string, AlignBar>>();
  for (const symbol of MPR_SYMBOLS) {
    maps.set(symbol, new Map((bySymbol[symbol] ?? []).map((bar) => [bar.date, bar])));
  }

  const dates = [...maps.get("SPY")!.keys()]
    .filter((date) => MPR_SYMBOLS.every((symbol) => maps.get(symbol)!.has(date)))
    .sort();

  return dates.map((date) => {
    const pick = (symbol: MprSymbol) => maps.get(symbol)!.get(date)!;
    const spy = pick("SPY");
    return {
      date,
      spyClose: spy.close,
      spyVolume: spy.volume,
      rspClose: pick("RSP").close,
      tltClose: pick("TLT").close,
      dxyClose: pick("DXY").close,
      hygClose: pick("HYG").close,
      ieiClose: pick("IEI").close,
      vixClose: pick("VIX").close,
      vix9dClose: pick("VIX9D").close,
      vix3mClose: pick("VIX3M").close,
    };
  });
}

function toSigma(stress: number): MprSigma {
  if (stress >= 75) return 2;
  if (stress >= 50) return 1;
  return 0;
}

export function computeMprSeries(rows: MprInput[], params: MprParams = MPR_DEFAULTS): MprDay[] {
  const { calibLen, driftLen, dynLen, tauPersist } = params;
  const n = rows.length;

  const spyClose = rows.map((r) => r.spyClose);
  const spyVolume = rows.map((r) => r.spyVolume);

  const spyEma50 = emaSeries(spyClose, 50);
  const spyRet5 = rocSeries(spyClose, driftLen);
  const spyHighCalib = highestSeries(spyClose, calibLen);
  const spyLowCalib = lowestSeries(spyClose, calibLen);
  const spyHigh20 = highestSeries(spyClose, 20);
  const spyVolSma20 = smaSeries(spyVolume, 20);
  const tltRet = rocSeries(
    rows.map((r) => r.tltClose),
    driftLen,
  );
  const dxyRet = rocSeries(
    rows.map((r) => r.dxyClose),
    driftLen,
  );
  const rspRet = rocSeries(
    rows.map((r) => r.rspClose),
    driftLen,
  );

  // ---- F1 量价推进效率 ----
  const f1Raw: (number | null)[] = rows.map((row, i) => {
    const hi = spyHighCalib[i];
    const lo = spyLowCalib[i];
    if (hi == null || lo == null) return null;

    const loc = hi - lo === 0 ? 0.5 : (row.spyClose - lo) / (hi - lo);
    const volBase = spyVolSma20[i] ?? row.spyVolume;
    const rvol = volBase === 0 ? 1 : row.spyVolume / volBase;
    const prevClose = i >= driftLen ? spyClose[i - driftLen] : row.spyClose;
    const move = prevClose === 0 ? 0 : (Math.abs(row.spyClose - prevClose) / prevClose) * 100;
    const eff = move / (rvol + 0.1);
    return loc * Math.log(1 + 1 / (eff + 0.05));
  });
  const f1 = rollingEcdf(f1Raw, calibLen);

  // ---- F2 隐波期限倒挂（含真实阈值滤波）----
  const rawTerm = rows.map((r) => (r.vix3mClose > 0 ? r.vix9dClose / r.vix3mClose : 1));
  const f2Ecdf = rollingEcdf(rawTerm, calibLen);
  const f2 = f2Ecdf.map((v, i) => (rawTerm[i] < 0.9 || rows[i].vixClose < 16 ? Math.min(v, 45) : v));

  // ---- F3 跨资产避险脱节 ----
  const macroBreak: (number | null)[] = rows.map((_, i) => {
    const ret5 = spyRet5[i];
    const tlt = tltRet[i];
    const dxy = dxyRet[i];
    if (ret5 == null || tlt == null || dxy == null) return null;
    return (ret5 < 0 ? 1.0 : 0.2) * (Math.max(0, tlt) + Math.max(0, dxy));
  });
  const f3 = rollingEcdf(macroBreak, calibLen);

  // ---- F4 信用利差紧缩 ----
  const rawCred = rows.map((r) => (r.hygClose > 0 ? r.ieiClose / r.hygClose : 1));
  const f4 = rollingEcdf(rawCred, calibLen);

  // ---- F5 现货广度背离 ----
  const dispersion: (number | null)[] = rows.map((_, i) => {
    const spy = spyRet5[i];
    const rsp = rspRet[i];
    if (spy == null || rsp == null) return null;
    return spy - rsp;
  });
  const f5 = rollingEcdf(dispersion, calibLen);

  // ---- 三域聚合压力（transVel 需要它的历史值，先整体算好）----
  const stressAgg = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const domVol = f2[i];
    const domCred = Math.max(f4[i], f3[i]);
    const domSpot = Math.max(f5[i], f1[i]);
    stressAgg[i] = domVol * 0.35 + domCred * 0.35 + domSpot * 0.3;
  }

  // ---- 有状态遍历 ----
  const out: MprDay[] = [];
  let leadPersist = 0;

  for (let i = 0; i < n; i += 1) {
    const domVol = f2[i];
    const domCred = Math.max(f4[i], f3[i]);
    const domSpot = Math.max(f5[i], f1[i]);

    const sigmaVol = toSigma(domVol);
    const sigmaCred = toSigma(domCred);
    const sigmaSpot = toSigma(domSpot);

    const nActive = (sigmaVol >= 1 ? 1 : 0) + (sigmaCred >= 1 ? 1 : 0) + (sigmaSpot >= 1 ? 1 : 0);
    const geomTension = Math.cbrt((domVol / 100) * (domCred / 100) * (domSpot / 100));
    const couplingRatio = (nActive / 3) * geomTension;

    const high20 = spyHigh20[i];
    const ddPct = high20 != null && high20 > 0 ? ((spyClose[i] - high20) / high20) * 100 : 0;
    const ema50 = spyEma50[i];
    const isBelowEma50 = ema50 != null && spyClose[i] < ema50;

    let spyDamage: number;
    if (ddPct <= -5 || (ddPct <= -2.5 && isBelowEma50)) spyDamage = 85;
    else if (ddPct <= -2 || isBelowEma50) spyDamage = 60;
    else if (ddPct <= -0.8) spyDamage = 35;
    else spyDamage = 10;

    const leadGap = Math.max(domVol, domCred) - spyDamage;
    leadPersist = leadGap > 20 && spyDamage < 40 ? leadPersist + 1 : 0;
    const leadDecay = 1 - Math.exp(-leadPersist / tauPersist);
    const leadQuality = Math.max(0, leadGap * leadDecay);

    let pathId: MprPathId;
    let transDepth: number;
    if (isBelowEma50 && spyDamage >= 70) {
      pathId = 4;
      transDepth = 3;
    } else if ((sigmaVol >= 1 || sigmaCred >= 1) && sigmaSpot >= 1 && spyDamage < 60) {
      pathId = 2;
      transDepth = 2;
    } else if ((sigmaVol >= 1 || sigmaCred >= 1) && sigmaSpot === 0) {
      pathId = 1;
      transDepth = 1;
    } else if (sigmaSpot >= 1 && sigmaVol === 0 && sigmaCred === 0) {
      pathId = 3;
      transDepth = 1;
    } else {
      pathId = 0;
      transDepth = 0;
    }

    const alphaBase =
      pathId === 4 ? 1.2 : pathId === 2 ? 0.35 : pathId === 1 ? -0.65 : pathId === 3 ? -0.5 : -1.6;
    const logit = alphaBase + 0.9 * couplingRatio + 0.35 * Math.log(leadPersist + 1);
    const prob5dDown = (1 / (1 + Math.exp(-logit))) * 100;

    const expSeverity =
      pathId === 4 ? 1.25 : pathId === 2 ? 1.05 : pathId === 1 ? 0.75 : pathId === 3 ? 0.6 : 0.35;
    const marketRiskScore = Math.min(
      100,
      Math.max(5, prob5dDown * expSeverity * (1 + 0.15 * transDepth)),
    );

    const fsmState = pathId === 4 ? 3 : pathId === 2 ? 2 : pathId === 1 || pathId === 3 ? 1 : 0;

    const aggPrev = i >= dynLen ? stressAgg[i - dynLen] : stressAgg[i];
    const transVel = (stressAgg[i] - aggPrev) / 100;

    out.push({
      date: rows[i].date,
      f1: f1[i],
      f2: f2[i],
      f3: f3[i],
      f4: f4[i],
      f5: f5[i],
      rawTerm: rawTerm[i],
      rawCred: rawCred[i],
      domVol,
      domCred,
      domSpot,
      sigmaVol,
      sigmaCred,
      sigmaSpot,
      couplingRatio,
      spyDamage,
      leadGap,
      leadPersist,
      leadQuality,
      pathId,
      transDepth,
      fsmState,
      prob5dDown,
      marketRiskScore,
      transVel,
    });
  }

  return out;
}
