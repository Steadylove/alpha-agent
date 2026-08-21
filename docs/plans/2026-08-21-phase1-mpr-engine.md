# Phase 1 · MPR 引擎实现计划

**目标:** 用 TypeScript 纯函数复现 TradingView 上的 MPR V2 宏观相变引擎,并用 15 年历史数据校准其预测力。

**架构:** 三层。底层 `series.ts` 提供 Pine 序列函数的等价实现;中层 `mpr.ts` 先向量化算出五力场,
再单次有状态遍历产出逐日路径与概率;上层校准脚本从 `DailyBar` 表读数据跑全历史。
不碰数据库写入、不碰前端、不碰 Discord——那些是 Phase 2。

**技术栈:** TypeScript、vitest、Prisma(只读)、tsx

**真值来源:** TradingView 上的 MPR 指标。Task 7 的对拍是本阶段的验收硬门槛。

---

## 关键设计决策(开工前必读)

**1. MPR 是有状态的,不是窗口纯函数。**
Pine 源码第 142 行 `var int lead_persist = 0` 是跨 bar 持久变量,每天基于前一天的值递推。
这意味着不能"给我最近 252 根算出今天的值"——必须从头逐日跑完整序列。
所以对外接口是 `computeMprSeries(rows) => MprDay[]`,取最新值是 `at(-1)`。

**2. `f_rolling_ecdf` 的 na 处理必须逐字镜像。**
Pine 第 17 行:`nz(ta.percentrank(nz(src, 0.0), len), 50.0)`。
注意是**先**把 na 源值替换成 `0.0` 再做 percentrank,**后**把 percentrank 的 na 结果替换成 `50.0`。
两次 nz 的填充值不同,顺序也不能颠倒,否则早期 bar 的结果会偏。

**3. `ta.percentrank` 的窗口不含当前 bar。**
Pine 文档:"percents of how many previous values was less than or equal to the current value"。
即窗口是 `[i-len, i-1]`,分母是 `len`。而 `ta.highest/lowest` 的窗口**含**当前 bar。
这两个语义不一致是最容易写错的地方,已在 Task 1 单测里锁死。
若 Task 7 对拍发现偏差,第一个要怀疑的就是这里。

**4. F3 需要 DXY,不是 UUP。**
Pine 第 73 行用 `TVC:DXY`。当前库里回填的是 UUP(美元看涨基金),有费率损耗且价格量纲不同。
已验证 Yahoo 的 `DX-Y.NYB` 可用(2011-01-03 起 4749 根,最新 99.64)。Task 6 补回填。

**5. Pine 源码里有两个死变量,不要照抄。**
- 第 74 行声明了 `gld_c_loc`,但五个力场无一使用它(F3 只用 TLT + DXY)。
  不要因为它出现在数据依赖列表里就以为需要它。本实现不加载 GLD。
- 第 79 行算了 `spy_ema20`,但核心函数里只有 `spy_ema50` 被用到(第 129 行)。
  本实现只算 EMA50。

(注:`f_calc_mpr_v2_core` 之外的主图部分另有一组 `ema20/ema50`,那是给个股 RS 判定用的,
与 MPR 无关,不在 Phase 1 范围内。)

**6. 数据窗口起点是 2011-01-04。**
受 VIX9D 上线时间约束。ECDF 需要 252 根预热,所以真正有效的 MPR 输出从第 253 个交易日
(约 2012-01)开始。校准表要剔除预热期。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/lib/scoring/series.ts`(新建) | Pine 序列函数等价实现,返回等长数组,不足处为 `null` |
| `tests/series.test.ts`(新建) | 序列函数手算验证 |
| `src/lib/scoring/mpr.ts`(新建) | 五力场 → 三域 → 路径 → 概率,含日期对齐辅助 |
| `tests/mpr.test.ts`(新建) | 力场、路径优先级、状态递推、对拍 |
| `scripts/backfill-macro-history.ts`(修改) | 增加 DXY 标的 |
| `scripts/calibrate-mpr.ts`(新建) | 全历史逐日跑 MPR,产出校准表 |

为什么 `series.ts` 不并进现有的 `indicators.ts`:后者所有函数返回最后一根 bar 的**标量**
(如 `averageTrueRange(bars, 14): number | null`),而 MPR 全程需要**序列**。混在一个文件里
两种返回语义会持续引起误用。

---

## Task 1: 序列基础函数

**Files:**
- Create: `src/lib/scoring/series.ts`
- Test: `tests/series.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `tests/series.test.ts`:

```ts
import {
  emaSeries,
  highestSeries,
  lowestSeries,
  percentRankSeries,
  rocSeries,
  smaSeries,
} from "@/lib/scoring/series";
import { describe, expect, it } from "vitest";

describe("series primitives", () => {
  it("smaSeries: 不足窗口为 null，其后为窗口均值", () => {
    expect(smaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("emaSeries: 第 length 根以 SMA 播种，其后按 alpha 递推", () => {
    // length=3 -> alpha=0.5，播种 SMA([1,2,3])=2
    // i=3: 0.5*4 + 0.5*2 = 3
    // i=4: 0.5*5 + 0.5*3 = 4
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("rocSeries: (v[i] - v[i-len]) / v[i-len] * 100", () => {
    const out = rocSeries([100, 110, 121], 1);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(10, 10);
    expect(out[2]).toBeCloseTo(10, 10);
  });

  it("rocSeries: 基准为 0 时返回 null，不产生 Infinity", () => {
    expect(rocSeries([0, 5], 1)[1]).toBeNull();
  });

  it("highestSeries / lowestSeries: 窗口含当前 bar", () => {
    expect(highestSeries([3, 1, 4, 1, 5], 3)).toEqual([null, null, 4, 4, 5]);
    expect(lowestSeries([3, 1, 4, 1, 5], 3)).toEqual([null, null, 1, 1, 1]);
  });

  it("percentRankSeries: 窗口不含当前 bar，统计 <= 当前值的占比", () => {
    // len=3
    // i=3 (值 30)：窗口 [50,10,20] -> <=30 的有 10,20 -> 2/3*100
    // i=4 (值 25)：窗口 [10,20,30] -> <=25 的有 10,20 -> 2/3*100
    const out = percentRankSeries([50, 10, 20, 30, 25], 3);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).toBeCloseTo((2 / 3) * 100, 10);
    expect(out[4]).toBeCloseTo((2 / 3) * 100, 10);
  });

  it("percentRankSeries: 当前值为窗口最大时得 100", () => {
    expect(percentRankSeries([1, 2, 3, 99], 3)[3]).toBeCloseTo(100, 10);
  });

  it("percentRankSeries: 当前值严格小于窗口全部时得 0", () => {
    expect(percentRankSeries([10, 20, 30, 5], 3)[3]).toBeCloseTo(0, 10);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

命令:`npx vitest run tests/series.test.ts`
预期:FAIL,报错 `Failed to resolve import "@/lib/scoring/series"`

- [ ] **Step 3: 写实现**

创建 `src/lib/scoring/series.ts`:

```ts
/**
 * Pine Script 序列函数的等价实现。
 *
 * 与 indicators.ts 的分工：indicators 返回最后一根 bar 的标量，本模块返回逐日序列。
 * MPR 的 ECDF 与跨 bar 状态递推必须拿到完整序列，故单开一个模块。
 *
 * 所有函数返回与输入等长的数组，数据不足的位置为 null。
 */

export function smaSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j += 1) {
      sum += values[j];
    }
    out[i] = sum / length;
  }
  return out;
}

/** 与 ta.ema 一致：第 length 根用 SMA 播种，其后 alpha = 2/(length+1) 递推。 */
export function emaSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < length) return out;

  let seed = 0;
  for (let j = 0; j < length; j += 1) {
    seed += values[j];
  }
  let prev = seed / length;
  out[length - 1] = prev;

  const alpha = 2 / (length + 1);
  for (let i = length; i < values.length; i += 1) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export function rocSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length; i < values.length; i += 1) {
    const base = values[i - length];
    out[i] = base === 0 ? null : ((values[i] - base) / base) * 100;
  }
  return out;
}

/** 与 ta.highest 一致：窗口含当前 bar。 */
export function highestSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i += 1) {
    let best = values[i - length + 1];
    for (let j = i - length + 2; j <= i; j += 1) {
      if (values[j] > best) best = values[j];
    }
    out[i] = best;
  }
  return out;
}

/** 与 ta.lowest 一致：窗口含当前 bar。 */
export function lowestSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i += 1) {
    let best = values[i - length + 1];
    for (let j = i - length + 2; j <= i; j += 1) {
      if (values[j] < best) best = values[j];
    }
    out[i] = best;
  }
  return out;
}

/**
 * 与 ta.percentrank 一致：统计**之前** length 根中 <= 当前值的占比（×100）。
 * 注意窗口是 [i-length, i-1]，不含当前 bar —— 与 highest/lowest 的语义相反。
 */
export function percentRankSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length; i < values.length; i += 1) {
    let count = 0;
    for (let j = i - length; j < i; j += 1) {
      if (values[j] <= values[i]) count += 1;
    }
    out[i] = (count / length) * 100;
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

命令:`npx vitest run tests/series.test.ts`
预期:PASS,8 passed

- [ ] **Step 5: 提交**

```bash
git add src/lib/scoring/series.ts tests/series.test.ts
git commit -m "Add Pine-equivalent series primitives"
```

---

## Task 2: 五力场计算

**Files:**
- Create: `src/lib/scoring/mpr.ts`
- Test: `tests/mpr.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `tests/mpr.test.ts`:

```ts
import { MPR_DEFAULTS, computeMprSeries, rollingEcdf, type MprInput } from "@/lib/scoring/mpr";
import { describe, expect, it } from "vitest";

/** 构造 n 天平稳上涨的输入，用于验证「无压力」基线。 */
function makeCalmInput(days: number): MprInput[] {
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    spyClose: 100 + i * 0.1,
    spyVolume: 80_000_000,
    rspClose: 100 + i * 0.1,
    tltClose: 100,
    dxyClose: 100,
    hygClose: 100,
    ieiClose: 100,
    vixClose: 14,
    vix9dClose: 13,
    vix3mClose: 16,
  }));
}

describe("rollingEcdf", () => {
  it("na 源值先填 0，percentrank 的 na 结果后填 50", () => {
    // 前 3 位不足窗口 -> percentrank 为 null -> 填 50
    const out = rollingEcdf([null, null, null, 1, 2], 3);
    expect(out.slice(0, 3)).toEqual([50, 50, 50]);
    // i=3：源被填成 [0,0,0]，当前值 1，窗口 [0,0,0] 全 <=1 -> 100
    expect(out[3]).toBeCloseTo(100, 10);
  });
});

describe("computeMprSeries", () => {
  it("输出长度与输入一致", () => {
    const rows = makeCalmInput(300);
    expect(computeMprSeries(rows)).toHaveLength(300);
  });

  it("平稳上涨行情下最终落在 Path 0 稳态", () => {
    const rows = makeCalmInput(400);
    const last = computeMprSeries(rows).at(-1)!;
    expect(last.pathId).toBe(0);
    expect(last.fsmState).toBe(0);
  });

  it("五力场输出恒在 0~100 区间", () => {
    const series = computeMprSeries(makeCalmInput(400));
    for (const day of series) {
      for (const v of [day.f1, day.f2, day.f3, day.f4, day.f5]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("风险分被夹在 5~100", () => {
    const series = computeMprSeries(makeCalmInput(400));
    for (const day of series) {
      expect(day.marketRiskScore).toBeGreaterThanOrEqual(5);
      expect(day.marketRiskScore).toBeLessThanOrEqual(100);
    }
  });

  it("F2 阈值滤波：VIX < 16 时压力被压到 45 以内", () => {
    // 构造 VIX9D/VIX3M 倒挂但 VIX 仍低的情形
    const rows = makeCalmInput(400).map((r, i) =>
      i > 300 ? { ...r, vix9dClose: 30, vix3mClose: 20, vixClose: 12 } : r,
    );
    const last = computeMprSeries(rows).at(-1)!;
    expect(last.f2).toBeLessThanOrEqual(45);
  });

  it("参数可覆盖 calibLen", () => {
    const rows = makeCalmInput(200);
    const series = computeMprSeries(rows, { ...MPR_DEFAULTS, calibLen: 60 });
    expect(series).toHaveLength(200);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

命令:`npx vitest run tests/mpr.test.ts`
预期:FAIL,报错 `Failed to resolve import "@/lib/scoring/mpr"`

- [ ] **Step 3: 写实现**

创建 `src/lib/scoring/mpr.ts`:

```ts
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
 * 有状态：lead_persist 跨日递推，必须从序列起点连续计算，不能只喂最近 N 根。
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
  const tltRet = rocSeries(rows.map((r) => r.tltClose), driftLen);
  const dxyRet = rocSeries(rows.map((r) => r.dxyClose), driftLen);
  const rspRet = rocSeries(rows.map((r) => r.rspClose), driftLen);

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
  const f2 = f2Ecdf.map((v, i) =>
    rawTerm[i] < 0.9 || rows[i].vixClose < 16 ? Math.min(v, 45) : v,
  );

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

    const nActive =
      (sigmaVol >= 1 ? 1 : 0) + (sigmaCred >= 1 ? 1 : 0) + (sigmaSpot >= 1 ? 1 : 0);
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

    const fsmState =
      pathId === 4 ? 3 : pathId === 2 ? 2 : pathId === 1 || pathId === 3 ? 1 : 0;

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
```

- [ ] **Step 4: 运行测试确认通过**

命令:`npx vitest run tests/mpr.test.ts`
预期:PASS,7 passed

- [ ] **Step 5: 提交**

```bash
git add src/lib/scoring/mpr.ts tests/mpr.test.ts
git commit -m "Add MPR five force fields and path engine"
```

---

## Task 3: 路径优先级与状态递推的针对性测试

前一个 Task 只验证了「平稳行情落在 Path 0」。路径判定的分支优先级和 `leadPersist`
的递推/清零是最容易出错且最难从平稳数据里暴露的部分,单独补一组测试。

**Files:**
- Modify: `tests/mpr.test.ts`

- [ ] **Step 1: 追加测试**

在 `tests/mpr.test.ts` 末尾追加:

```ts
describe("path priority and stateful lead persist", () => {
  /** 构造前段平稳、后段急跌的行情，用于触发高 Path。 */
  function makeCrashInput(days: number, crashFrom: number): MprInput[] {
    return Array.from({ length: days }, (_, i) => {
      const crashing = i >= crashFrom;
      const drop = crashing ? (i - crashFrom) * 1.5 : 0;
      const base = 100 + Math.min(i, crashFrom) * 0.1 - drop;
      return {
        date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
        spyClose: Math.max(base, 10),
        spyVolume: crashing ? 200_000_000 : 80_000_000,
        rspClose: Math.max(base - drop * 0.3, 10),
        tltClose: crashing ? 100 + drop * 0.4 : 100,
        dxyClose: crashing ? 100 + drop * 0.2 : 100,
        hygClose: crashing ? Math.max(100 - drop, 10) : 100,
        ieiClose: 100,
        vixClose: crashing ? 35 : 14,
        vix9dClose: crashing ? 45 : 13,
        vix3mClose: crashing ? 30 : 16,
      };
    });
  }

  it("急跌行情最终进入 Path 4 破位确认", () => {
    const last = computeMprSeries(makeCrashInput(400, 320)).at(-1)!;
    expect(last.pathId).toBe(4);
    expect(last.fsmState).toBe(3);
    expect(last.transDepth).toBe(3);
  });

  it("路径判定的不变量在全序列成立", () => {
    for (const day of computeMprSeries(makeCrashInput(400, 320))) {
      // Path 2 的定义里含 spyDamage < 60，破坏度过高时必须让位给 Path 4
      if (day.pathId === 2) expect(day.spyDamage).toBeLessThan(60);
      // Path 1 要求现货域完全平静
      if (day.pathId === 1) expect(day.sigmaSpot).toBe(0);
      // Path 3 要求衍生品域与信用域都平静
      if (day.pathId === 3) {
        expect(day.sigmaVol).toBe(0);
        expect(day.sigmaCred).toBe(0);
      }
      // transDepth 与 pathId 一一对应
      const expectedDepth = { 0: 0, 1: 1, 2: 2, 3: 1, 4: 3 }[day.pathId];
      expect(day.transDepth).toBe(expectedDepth);
    }
  });

  it("leadPersist 在条件不满足时清零，不携带历史", () => {
    const series = computeMprSeries(makeCalmInput(400));
    // 平稳行情下 leadGap 不会持续 > 20，应大量出现 0
    expect(series.filter((d) => d.leadPersist === 0).length).toBeGreaterThan(0);
  });

  it("leadPersist 连续满足条件时逐日 +1", () => {
    const series = computeMprSeries(makeCrashInput(400, 320));
    for (let i = 1; i < series.length; i += 1) {
      const cur = series[i].leadPersist;
      const prev = series[i - 1].leadPersist;
      // 只可能是 prev+1 或归零
      expect(cur === prev + 1 || cur === 0).toBe(true);
    }
  });

  it("Path 0 时 leadQuality 与 couplingRatio 皆非负", () => {
    for (const day of computeMprSeries(makeCalmInput(400))) {
      expect(day.leadQuality).toBeGreaterThanOrEqual(0);
      expect(day.couplingRatio).toBeGreaterThanOrEqual(0);
    }
  });
});
```

- [ ] **Step 2: 运行测试**

命令:`npx vitest run tests/mpr.test.ts`
预期:PASS,12 passed

若「急跌行情最终进入 Path 4」失败,说明构造的行情没跌破 50EMA 或 `spyDamage` 没到 70,
调大 `makeCrashInput` 的 `drop` 斜率或提前 `crashFrom`,不要改实现去迁就测试。

- [ ] **Step 3: 提交**

```bash
git add tests/mpr.test.ts
git commit -m "Test MPR path priority and lead persist"
```

---

## Task 4: 多标的日期对齐

校准脚本要从 `DailyBar` 表读 9 个标的,它们的交易日历不完全一致
(已实测 DXY 有 4749 根而 UUP 只有 3928 根)。必须内连接到共同交易日。

**Files:**
- Modify: `src/lib/scoring/mpr.ts`(追加导出)
- Modify: `tests/mpr.test.ts`(追加测试)

- [ ] **Step 1: 写失败的测试**

先把 `tests/mpr.test.ts` 顶部已有的 import 改为(追加 `alignMprInputs`,不要新起一条 import 语句):

```ts
import {
  MPR_DEFAULTS,
  alignMprInputs,
  computeMprSeries,
  rollingEcdf,
  type MprInput,
} from "@/lib/scoring/mpr";
```

再在文件末尾追加:

```ts
describe("alignMprInputs", () => {
  const bars = (dates: string[], close: number) =>
    dates.map((date) => ({ date, close, volume: 1_000 }));

  it("只保留所有标的都有数据的交易日", () => {
    const rows = alignMprInputs({
      SPY: bars(["2020-01-01", "2020-01-02", "2020-01-03"], 100),
      RSP: bars(["2020-01-01", "2020-01-03"], 50),
      TLT: bars(["2020-01-01", "2020-01-02", "2020-01-03"], 90),
      DXY: bars(["2020-01-01", "2020-01-02", "2020-01-03"], 95),
      HYG: bars(["2020-01-01", "2020-01-02", "2020-01-03"], 80),
      IEI: bars(["2020-01-01", "2020-01-02", "2020-01-03"], 120),
      VIX: bars(["2020-01-01", "2020-01-02", "2020-01-03"], 15),
      VIX9D: bars(["2020-01-01", "2020-01-02", "2020-01-03"], 14),
      VIX3M: bars(["2020-01-01", "2020-01-02", "2020-01-03"], 17),
    });

    expect(rows.map((r) => r.date)).toEqual(["2020-01-01", "2020-01-03"]);
  });

  it("输出按日期升序", () => {
    const d = ["2020-01-03", "2020-01-01", "2020-01-02"];
    const rows = alignMprInputs({
      SPY: bars(d, 100),
      RSP: bars(d, 50),
      TLT: bars(d, 90),
      DXY: bars(d, 95),
      HYG: bars(d, 80),
      IEI: bars(d, 120),
      VIX: bars(d, 15),
      VIX9D: bars(d, 14),
      VIX3M: bars(d, 17),
    });
    expect(rows.map((r) => r.date)).toEqual(["2020-01-01", "2020-01-02", "2020-01-03"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

命令:`npx vitest run tests/mpr.test.ts`
预期:FAIL,`alignMprInputs is not a function`

- [ ] **Step 3: 实现**

在 `src/lib/scoring/mpr.ts` 末尾追加:

```ts
/** 对齐用的最小 bar 结构，避免校准脚本被迫构造完整 DailyBar。 */
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

  const spyMap = maps.get("SPY")!;
  const dates = [...spyMap.keys()]
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
```

- [ ] **Step 4: 运行测试**

命令:`npx vitest run tests/mpr.test.ts`
预期:PASS,14 passed

- [ ] **Step 5: 提交**

```bash
git add src/lib/scoring/mpr.ts tests/mpr.test.ts
git commit -m "Add macro series date alignment"
```

---

## Task 5: 补回填 DXY

**Files:**
- Modify: `scripts/backfill-macro-history.ts`

- [ ] **Step 1: 给 MacroTarget 增加拉取代码字段**

把 `MacroTarget` 类型改为(新增 `fetchSymbol`):

```ts
type MacroTarget = {
  symbol: string;
  /** 数据源侧的代码。仅当与入库 symbol 不同时才需要，如 DXY 在 Yahoo 上是 DX-Y.NYB。 */
  fetchSymbol?: string;
  name: string;
  type: InstrumentType;
  /** yahoo=ETF 行情；cboe=波动率指数全历史 CSV */
  source: "yahoo" | "cboe";
  role: string;
};
```

- [ ] **Step 2: 在 MACRO_TARGETS 里加 DXY**

在 `UUP` 那一行下面插入:

```ts
  { symbol: "DXY", fetchSymbol: "DX-Y.NYB", name: "ICE US Dollar Index", type: "INDEX", source: "yahoo", role: "F3 美元指数" },
```

- [ ] **Step 3: 让 fetchHistory 使用 fetchSymbol**

把 `fetchHistory` 改为:

```ts
async function fetchHistory(target: MacroTarget): Promise<DailyBar[]> {
  if (target.source === "cboe") {
    return fetchCboeVolIndexHistory(target.symbol as CboeVolIndex);
  }
  return fetchYahooDailyBars(target.fetchSymbol ?? target.symbol, { years: HISTORY_YEARS });
}
```

注意 `fetchYahooDailyBars` 返回的 bar 里 `symbol` 字段是拉取代码(`DX-Y.NYB`),
而入库用的是 `instrument.id`,不读 bar 的 symbol 字段,所以无需额外改写。

- [ ] **Step 4: 运行回填**

命令:`npm run backfill:macro`
预期输出包含一行:

```
✓ DXY     3900+ 根  新增 3900+  2006-xx-xx → 2026-08-xx  (F3 美元指数)
```

其余 10 个标的应显示「新增 0」(已回填过,`skipDuplicates` 生效)。

- [ ] **Step 5: 校验落库结果**

命令:

```bash
npx --yes tsx -e '
import "dotenv/config";
import { getPrisma } from "@/lib/db/prisma";
const p = getPrisma();
const inst = await p.instrument.findUnique({ where: { symbol: "DXY" } });
if (!inst) throw new Error("DXY instrument missing");
const n = await p.dailyBar.count({ where: { instrumentId: inst.id } });
const first = await p.dailyBar.findFirst({ where: { instrumentId: inst.id }, orderBy: { date: "asc" } });
const last = await p.dailyBar.findFirst({ where: { instrumentId: inst.id }, orderBy: { date: "desc" } });
console.log(n, first?.date.toISOString().slice(0,10), last?.date.toISOString().slice(0,10), last?.close);
await p.$disconnect();
'
```

预期:根数 > 3800,最后一根收盘价在 90~110 区间(DXY 正常量纲,不是 UUP 的 ~28)。

- [ ] **Step 6: 提交**

```bash
git add scripts/backfill-macro-history.ts
git commit -m "Backfill DXY index for F3 force field"
```

---

## Task 6: 校准脚本

**Files:**
- Create: `scripts/calibrate-mpr.ts`
- Modify: `package.json`

- [ ] **Step 1: 写脚本**

创建 `scripts/calibrate-mpr.ts`:

```ts
import "dotenv/config";

import { getPrisma } from "@/lib/db/prisma";
import {
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  type AlignBar,
  type MprSymbol,
} from "@/lib/scoring/mpr";

/**
 * 在全历史上逐日跑 MPR，产出「各 Path 下未来 5 日实际下跌频率」校准表。
 *
 * 这张表回答的是：Pine 里那些写死的 alpha_base / severity 系数，在真实历史上站不站得住。
 */

/** ECDF 需要 252 根预热，之前的输出无意义，统计时剔除。 */
const WARMUP_BARS = 252;
const FORWARD_DAYS = 5;

async function loadBars(): Promise<Record<MprSymbol, AlignBar[]>> {
  const prisma = getPrisma();
  const result = {} as Record<MprSymbol, AlignBar[]>;

  for (const symbol of MPR_SYMBOLS) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) {
      throw new Error(`Instrument ${symbol} not found. Run: npm run backfill:macro`);
    }
    const bars = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { date: true, close: true, volume: true },
    });
    result[symbol] = bars.map((bar) => ({
      date: bar.date.toISOString().slice(0, 10),
      close: bar.close,
      volume: Number(bar.volume),
    }));
  }

  return result;
}

async function main() {
  const bySymbol = await loadBars();
  const rows = alignMprInputs(bySymbol);
  console.log(`对齐后交易日: ${rows.length} (${rows[0]?.date} → ${rows.at(-1)?.date})`);

  const series = computeMprSeries(rows);
  const closes = rows.map((r) => r.spyClose);

  type Bucket = { n: number; down: number; drop3: number; sumRet: number };
  const buckets = new Map<number, Bucket>();

  for (let i = WARMUP_BARS; i < series.length - FORWARD_DAYS; i += 1) {
    const fwd = ((closes[i + FORWARD_DAYS] - closes[i]) / closes[i]) * 100;
    const path = series[i].pathId;
    const bucket = buckets.get(path) ?? { n: 0, down: 0, drop3: 0, sumRet: 0 };
    bucket.n += 1;
    if (fwd < 0) bucket.down += 1;
    if (fwd <= -3) bucket.drop3 += 1;
    bucket.sumRet += fwd;
    buckets.set(path, bucket);
  }

  const pathNames: Record<number, string> = {
    0: "P0 稳态自洽",
    1: "P1 跨市场暗流",
    2: "P2 相变扩散",
    3: "P3 微观漂移",
    4: "P4 破位确认",
  };

  console.log("");
  console.log("Path            样本   占比    5D下跌频率  5D跌>3%   5D平均收益  模型预测概率");
  console.log("─".repeat(88));

  const total = [...buckets.values()].reduce((sum, b) => sum + b.n, 0);

  for (const path of [0, 1, 2, 3, 4]) {
    const b = buckets.get(path);
    if (!b || b.n === 0) {
      console.log(`${pathNames[path].padEnd(14)} ${String(0).padStart(5)}   (无样本)`);
      continue;
    }
    // 该 Path 下模型给出的平均预测概率，用于和实际频率对照
    const predicted =
      series
        .slice(WARMUP_BARS, series.length - FORWARD_DAYS)
        .filter((d) => d.pathId === path)
        .reduce((sum, d) => sum + d.prob5dDown, 0) / b.n;

    console.log(
      `${pathNames[path].padEnd(14)} ${String(b.n).padStart(5)} ` +
        `${((b.n / total) * 100).toFixed(1).padStart(6)}% ` +
        `${((b.down / b.n) * 100).toFixed(1).padStart(10)}% ` +
        `${((b.drop3 / b.n) * 100).toFixed(1).padStart(8)}% ` +
        `${(b.sumRet / b.n).toFixed(2).padStart(11)}% ` +
        `${predicted.toFixed(1).padStart(12)}%`,
    );
  }

  console.log("");
  console.log("判读要点：");
  console.log("  - 「5D下跌频率」应随 Path 序号单调上升，否则路径分级没有区分度。");
  console.log("  - 「模型预测概率」与「5D下跌频率」的差距即 alpha_base 的校准误差。");
  console.log("  - P2 是核心吹哨路径，若其样本数 < 30，则该路径的统计结论不可信。");

  await getPrisma().$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await getPrisma().$disconnect();
  process.exit(1);
});
```

- [ ] **Step 2: 加 npm 脚本**

在 `package.json` 的 `scripts` 里,`backfill:macro` 下面加一行:

```json
    "calibrate:mpr": "npx --yes tsx scripts/calibrate-mpr.ts"
```

- [ ] **Step 3: 运行校准**

命令:`npm run calibrate:mpr`

预期:输出对齐交易日数(约 3900)与五行 Path 统计表。

**这一步的产出就是 Phase 1 的核心交付物。** 拿到表后要人工判读:
- 若 5D 下跌频率随 Path 单调上升 → 路径分级有效,可以进 Phase 2。
- 若 P2 的下跌频率低于 P0 → 说明移植有 bug 或该路径在美股上无效,回到 Task 7 对拍。
- 若某 Path 样本数为 0 → 检查是不是阈值写错导致该分支永不触发。

- [ ] **Step 4: 提交**

```bash
git add scripts/calibrate-mpr.ts package.json
git commit -m "Add MPR historical calibration script"
```

---

## Task 7: 与 TradingView 对拍(验收门槛)

这是 Phase 1 的**唯一硬性验收标准**。前面所有测试都只能证明「实现自洽」,
证明不了「实现与 Pine 原版一致」。

**注意区分:** TradingView 在这里只是**验证用的参照实现**,不是数据源。
生产环境的行情全部来自 Yahoo 与 CBOE,运行时代码里不会出现 TradingView。
本 Task 是一次性的人工操作,做完即止。

**为什么非做不可:** Pine 有几处语义读代码定不下来,最典型的是
`ta.percentrank` 的窗口含不含当前 bar。含与不含会让五个力场的 ECDF 全体偏一两个百分点——
不足以让前面的单测失败,也不足以肉眼看出,但会让 Path 在 50/75 两个阈值边界上判错,
进而让下游所有依赖 Path 的仓位上限和估值折现系数全错。
这类**小的系统性偏差**只有对拍能抓出来。

**Files:**
- Create: `scripts/compare-mpr-tradingview.ts`
- Create: `tests/fixtures/mpr-golden.json`(由脚本生成后提交)
- Create: `tests/mpr-golden.test.ts`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: 忽略 tmp 目录**

在 `.gitignore` 末尾追加:

```
# 对拍用的本地导出文件
tmp/
```

- [ ] **Step 2: 从 TradingView 导出全历史 CSV**

按 `docs/plans/tradingview-export-patch.pine` 的说明操作。要点复述:

1. **复制**一份 MPR 指标(别改原件),把补丁里 16 行 `plot()` 粘到副本末尾。
2. 图表切到 **SPY、日线**。必须是 SPY——`lead_persist` 是跨 bar 递推状态,
   按哪个标的的交易日历推进取决于图表标的,而我们的实现对齐到 SPY 日历。
3. 向左滚动图表直到加载出 2010 年以前的数据(TradingView 懒加载,不滚到底只导最近几年)。
4. 「...」→ 导出图表数据 → CSV → 下载。
5. 存到 `tmp/mpr-tradingview.csv`。

导出的 CSV 应含 `time` 列与 16 个 `exp_*` 列,行数约 3900+。

- [ ] **Step 3: 写全历史对拍脚本**

创建 `scripts/compare-mpr-tradingview.ts`:

```ts
import "dotenv/config";

import { readFileSync } from "node:fs";

import { getPrisma } from "@/lib/db/prisma";
import {
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  type AlignBar,
  type MprDay,
  type MprSymbol,
} from "@/lib/scoring/mpr";

/**
 * 把本地 MPR 实现与 TradingView 导出的 CSV 逐日对拍。
 *
 * CSV 由 docs/plans/tradingview-export-patch.pine 生成，是 Pine 原版的真值。
 * 本脚本只读不写，输出每个字段的最大偏差与首个失配日期。
 */

const CSV_PATH = "tmp/mpr-tradingview.csv";
/** ECDF 预热期内两边都无意义，跳过。 */
const WARMUP_BARS = 252;
const TOLERANCE = 0.5;

/** CSV 列名 -> MprDay 字段名 */
const FIELD_MAP = {
  exp_f1: "f1",
  exp_f2: "f2",
  exp_f3: "f3",
  exp_f4: "f4",
  exp_f5: "f5",
  exp_path_id: "pathId",
  exp_fsm_state: "fsmState",
  exp_spy_damage: "spyDamage",
  exp_lead_gap: "leadGap",
  exp_lead_persist: "leadPersist",
  exp_lead_quality: "leadQuality",
  exp_prob_5d_down: "prob5dDown",
  exp_risk_score: "marketRiskScore",
  exp_trans_vel: "transVel",
  exp_raw_term: "rawTerm",
  exp_raw_cred: "rawCred",
} as const satisfies Record<string, keyof MprDay>;

type CsvColumn = keyof typeof FIELD_MAP;

function parseCsv(text: string): Map<string, Record<CsvColumn, number>> {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((cell) => cell.trim());
  const timeIdx = header.findIndex((h) => h.toLowerCase() === "time");
  if (timeIdx < 0) throw new Error("CSV 缺少 time 列");

  const colIdx = {} as Record<CsvColumn, number>;
  for (const col of Object.keys(FIELD_MAP) as CsvColumn[]) {
    const idx = header.indexOf(col);
    if (idx < 0) {
      throw new Error(`CSV 缺少 ${col} 列。是否忘了粘贴 plot 补丁，或 display 参数导致未导出？`);
    }
    colIdx[col] = idx;
  }

  const out = new Map<string, Record<CsvColumn, number>>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    // TradingView 的 time 列可能是 ISO 时间戳，取前 10 位日期
    const date = cells[timeIdx]?.trim().slice(0, 10);
    if (!date) continue;

    const row = {} as Record<CsvColumn, number>;
    let ok = true;
    for (const col of Object.keys(FIELD_MAP) as CsvColumn[]) {
      const v = Number(cells[colIdx[col]]);
      if (!Number.isFinite(v)) ok = false;
      row[col] = v;
    }
    if (ok) out.set(date, row);
  }
  return out;
}

async function loadLocalSeries(): Promise<MprDay[]> {
  const prisma = getPrisma();
  const bySymbol = {} as Record<MprSymbol, AlignBar[]>;

  for (const symbol of MPR_SYMBOLS) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) throw new Error(`Instrument ${symbol} not found. Run: npm run backfill:macro`);
    const bars = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { date: true, close: true, volume: true },
    });
    bySymbol[symbol] = bars.map((bar) => ({
      date: bar.date.toISOString().slice(0, 10),
      close: bar.close,
      volume: Number(bar.volume),
    }));
  }

  return computeMprSeries(alignMprInputs(bySymbol));
}

async function main() {
  const expected = parseCsv(readFileSync(CSV_PATH, "utf8"));
  const local = await loadLocalSeries();
  console.log(`TradingView CSV: ${expected.size} 天`);
  console.log(`本地实现:        ${local.length} 天`);

  const comparable = local.slice(WARMUP_BARS).filter((day) => expected.has(day.date));
  console.log(`可对比交易日:    ${comparable.length} 天(已跳过 ${WARMUP_BARS} 根预热)`);
  console.log("");

  if (comparable.length === 0) {
    throw new Error("没有可对比的交易日。检查 CSV 的日期格式是否为 YYYY-MM-DD 开头。");
  }

  type Stat = { maxDiff: number; maxDate: string; failures: number; firstFailDate: string | null };
  const stats = new Map<CsvColumn, Stat>();

  for (const [col, field] of Object.entries(FIELD_MAP) as [CsvColumn, keyof MprDay][]) {
    const stat: Stat = { maxDiff: 0, maxDate: "", failures: 0, firstFailDate: null };
    for (const day of comparable) {
      const want = expected.get(day.date)![col];
      const got = day[field] as number;
      const diff = Math.abs(got - want);
      if (diff > stat.maxDiff) {
        stat.maxDiff = diff;
        stat.maxDate = day.date;
      }
      if (diff > TOLERANCE) {
        stat.failures += 1;
        if (stat.firstFailDate == null) stat.firstFailDate = day.date;
      }
    }
    stats.set(col, stat);
  }

  console.log("字段                 最大偏差   出现日期      超容差天数   首个失配日");
  console.log("─".repeat(78));
  let allPass = true;
  for (const [col, stat] of stats) {
    const pass = stat.failures === 0;
    if (!pass) allPass = false;
    console.log(
      `${(pass ? "✓ " : "✗ ") + col.padEnd(18)} ` +
        `${stat.maxDiff.toFixed(4).padStart(9)} ` +
        `${stat.maxDate.padStart(12)} ` +
        `${String(stat.failures).padStart(11)} ` +
        `${(stat.firstFailDate ?? "-").padStart(13)}`,
    );
  }

  console.log("");
  if (allPass) {
    console.log(`✓ 全部 ${comparable.length} 天、16 个字段均在容差 ${TOLERANCE} 内。`);
  } else {
    console.log(`✗ 存在超容差字段。排查顺序见 Task 7 Step 5。`);
    process.exitCode = 1;
  }

  await getPrisma().$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await getPrisma().$disconnect();
  process.exit(1);
});
```

在 `package.json` 的 `scripts` 里追加:

```json
    "compare:mpr": "npx --yes tsx scripts/compare-mpr-tradingview.ts"
```

- [ ] **Step 4: 运行对拍**

命令:`npm run compare:mpr`

预期:16 个字段全部 `✓`,末尾显示「全部 3xxx 天、16 个字段均在容差 0.5 内」。

**若失败,不要放宽 TOLERANCE**,按 Step 5 排查。

- [ ] **Step 5: 失配排查指引**

对拍脚本会告诉你**哪个字段**偏、**偏多少**、**从哪天开始**偏。按这个对照表定位:

| 现象 | 病因 | 处理 |
| --- | --- | --- |
| `exp_f1~f5` 全体小幅偏(< 2) | `percentRankSeries` 窗口边界 | 改成含当前 bar(窗口 `[i-length+1, i]`,分母仍 `length`)重跑 |
| 只有 `exp_f1` 偏 | `spy_eff` 的 `nz(spy_c_loc[d_len], ...)` 边界 | 检查 `i < driftLen` 时 `move` 是否为 0 |
| 只有 `exp_f3` 偏 | DXY 数据源差异 | TradingView 用 `TVC:DXY`,我们用 Yahoo `DX-Y.NYB`。先单独比 `dxyRet` |
| 只有 `exp_f2` 偏 | 阈值滤波 | 检查 `rawTerm < 0.9 \|\| vix < 16` 的短路顺序与 `Math.min(v, 45)` |
| `exp_raw_term`/`exp_raw_cred` 就偏 | 底层行情对不上 | 不是 MPR 的问题,是 VIX9D/VIX3M/IEI/HYG 数据源差异 |
| f 值全对但 `exp_lead_persist` 偏 | 序列起点不同 | TradingView 图表加载的起始日若晚于我们的库,persist 计数会不同。把本地序列截断到与 CSV 相同的首日重跑 |
| `exp_path_id` 对但 `exp_risk_score` 偏 | `transDepth` 或 severity 系数 | 逐个核对 Pine 第 171-173 行 |

- [ ] **Step 6: 冻结回归夹具**

对拍通过后,把结果抽样冻结成永久回归测试。CSV 本身不进 git(太大且是本地产物),
但抽 20 天的真值进夹具,以后任何人改动 `mpr.ts` 都会被这组测试挡住。

在 `scripts/compare-mpr-tradingview.ts` 的 `main()` 末尾、`$disconnect()` 之前插入:

```ts
  if (allPass && process.argv.includes("--freeze")) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    // 均匀抽 20 天，保证覆盖不同市场环境
    const step = Math.floor(comparable.length / 20);
    const sample = comparable
      .filter((_, i) => i % step === 0)
      .slice(0, 20)
      .map((day) => ({
        date: day.date,
        ...Object.fromEntries(
          (Object.entries(FIELD_MAP) as [CsvColumn, keyof MprDay][]).map(([col, field]) => [
            field,
            expected.get(day.date)![col],
          ]),
        ),
      }));
    mkdirSync("tests/fixtures", { recursive: true });
    writeFileSync("tests/fixtures/mpr-golden.json", `${JSON.stringify(sample, null, 2)}\n`);
    console.log(`已冻结 ${sample.length} 天真值到 tests/fixtures/mpr-golden.json`);
  }
```

运行:`npm run compare:mpr -- --freeze`

- [ ] **Step 7: 写永久回归测试**

创建 `tests/mpr-golden.test.ts`:

```ts
import { getPrisma } from "@/lib/db/prisma";
import {
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  type AlignBar,
  type MprSymbol,
} from "@/lib/scoring/mpr";
import { beforeAll, describe, expect, it } from "vitest";
import type { MprDay } from "@/lib/scoring/mpr";

import GOLDEN from "./fixtures/mpr-golden.json";

/**
 * MPR 移植的永久回归测试。
 *
 * 夹具里的数字来自 TradingView 导出的 Pine 原版真值（由 scripts/compare-mpr-tradingview.ts
 * --freeze 生成），不是本实现算出来的。任何一项对不上都说明 mpr.ts 被改坏了，
 * 不要通过放宽容差或重新冻结夹具来「修复」。
 */
const TOLERANCE = 0.5;

let byDate: Map<string, MprDay>;

beforeAll(async () => {
  const prisma = getPrisma();
  const bySymbol = {} as Record<MprSymbol, AlignBar[]>;

  for (const symbol of MPR_SYMBOLS) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) throw new Error(`Instrument ${symbol} not found`);
    const bars = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { date: true, close: true, volume: true },
    });
    bySymbol[symbol] = bars.map((bar) => ({
      date: bar.date.toISOString().slice(0, 10),
      close: bar.close,
      volume: Number(bar.volume),
    }));
  }

  const series = computeMprSeries(alignMprInputs(bySymbol));
  byDate = new Map(series.map((day) => [day.date, day]));
  await prisma.$disconnect();
});

describe("MPR golden regression against TradingView", () => {
  it("夹具已冻结", () => {
    expect(GOLDEN.length, "请先跑 npm run compare:mpr -- --freeze").toBeGreaterThan(0);
  });

  it.each(GOLDEN)("$date 与 Pine 原版一致", (expected) => {
    const actual = byDate.get(expected.date);
    expect(actual, `${expected.date} 不在对齐后的序列里`).toBeDefined();

    expect(actual!.pathId, `${expected.date} 的 pathId`).toBe(expected.pathId);
    expect(actual!.fsmState, `${expected.date} 的 fsmState`).toBe(expected.fsmState);
    expect(actual!.leadPersist, `${expected.date} 的 leadPersist`).toBe(expected.leadPersist);

    const numeric = [
      "f1",
      "f2",
      "f3",
      "f4",
      "f5",
      "spyDamage",
      "leadGap",
      "leadQuality",
      "prob5dDown",
      "marketRiskScore",
      "transVel",
      "rawTerm",
      "rawCred",
    ] as const;

    for (const key of numeric) {
      const diff = Math.abs(actual![key] - expected[key]);
      expect(
        diff,
        `${expected.date} 的 ${key}: 实际 ${actual![key].toFixed(4)} vs Pine ${expected[key]}`,
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});
```

导入 JSON 需要 `tsconfig.json` 里有 `"resolveJsonModule": true`。若报错就加上。

- [ ] **Step 8: 跑回归测试并提交**

命令:`npx vitest run tests/mpr-golden.test.ts`
预期:PASS,21 passed(1 条夹具检查 + 20 天真值)

```bash
git add scripts/compare-mpr-tradingview.ts tests/mpr-golden.test.ts tests/fixtures/mpr-golden.json package.json .gitignore
git commit -m "Verify MPR port against TradingView export"
```

---

## Task 8: 全量校验与阶段收尾

- [ ] **Step 1: 全量检查**

```bash
npx tsc --noEmit && npx eslint . && npm test
```

预期:tsc 无输出、eslint 无输出、所有测试通过。

- [ ] **Step 2: 把校准表结论写回总纲**

把 Task 6 产出的 Path 统计表贴进
`docs/plans/2026-08-21-quant-integration-roadmap.md` 的 Phase 1 小节,
并把状态从「待开工」改为「已完成」。

- [ ] **Step 3: 提交**

```bash
git add docs/plans/
git commit -m "Record MPR calibration results"
```

---

## 完成定义

Phase 1 完成需同时满足:

1. `npx tsc --noEmit`、`npx eslint .`、`npm test` 全绿。
2. `tests/mpr-golden.test.ts` 的 10 个日期全部与 TradingView 吻合(容差 0.5)。
3. `npm run calibrate:mpr` 能跑出五行 Path 统计表,且 5D 下跌频率随 Path 序号单调上升。
4. 校准结论已回写总纲。

**不满足第 2 条就不要进 Phase 2。** 一个没对拍过的宏观引擎,
后面所有依赖 Path 的选股、估值折现、仓位上限都建立在沙子上。
