# 机会层（行业抬头 → 动态对照）Implementation Plan

> **执行方式：** 本会话按阶段推进。每阶段可独立上线、有测试。不改现网买卖、账本写入、信号台扫描。

**Goal:** 单独加一个只读「机会」模块：行业时钟、行业广度、全市场强势候选、现网池按行业对照（含个股 RPS 速度）。改池仍是人拍板。

**Architecture:** 日更任务把公开行情算成一份 `snapshots/opportunity.json`，网站只读快照。行业层用已有 11 只 SPDR + SPY；个股层复用筛选任务已在算的标普截面，并把现网池里的非标普票并进去。不自动改 `signal-pool`。

**Tech Stack:** 现有 `sectorClock`、`loadDailyBars`、`writeSnapshot` / `readSnapshot`、`alphaScreener` 的四周期 RPS、Wikipedia 标普 GICS、Next.js 页面 + 导航。

---

## 硬约束

- 不改 `deskScan`、`champs`、`liveBooks` 写入、`signal-pool` 的保存逻辑。
- 不把 MPR 路径或轮动 40 只当成现网仓位。
- 新页文案必须写明：改池时看，不指挥这本账。
- 页面不现场扫 4H/2H、不现场拉 500 只日线。

## 现成数据（2026-09-11 已核对）

| 来源 | 够不够 |
|---|---|
| VPS `1d/SPY.csv` + `XLK`…`XLB` 各 504 根 | 够做时钟 |
| `computeSectorClockSeries` + 单测 | 够，未挂页面 |
| 筛选任务内存里的标普四周期 RPS | 够做候选和广度，**没落到 VPS 快照** |
| Wikipedia 标普 GICS（`fetchSp500Universe`） | 够映射大部分现网票 |
| 现网池里的非标普票（RKLB 等） | 无行业落库，需补公开 GICS / 手工表 |
| `snapshots/screener.json` | **缺失**（Discord 推送写在 runner 本地） |

## 公开数据补齐

1. 把筛选结果写进 VPS `snapshots/`（和 mpr 同一路径），日更链挂上。
2. 筛选计算时保留**全截面**摘要（每行业：样本数、强势数、抬头数），不只 elite。
3. 同一批日线再算 T-5 截面，得到 RPS 速度，不另买数据。
4. 非标普票：Wikipedia 没有的，用静态 `src/lib/opportunity/extraSectors.ts`（公开 GICS），缺的标「未分类」。FMP 只作软补全，失败不影响日更。

## 文件

**新建**

- `src/lib/opportunity/types.ts` — 快照类型
- `src/lib/opportunity/clockOf.ts` — 时钟日 → 11 档展示行
- `src/lib/opportunity/breadthOf.ts` — 截面 → 行业广度
- `src/lib/opportunity/velocityOf.ts` — 今日/T-5 分位差
- `src/lib/opportunity/extraSectors.ts` — 非标普行业
- `src/lib/jobs/opportunity.ts` — 日更：时钟 + 读筛选摘要
- `src/lib/dashboard/opportunity.ts` — 页面读快照
- `src/app/opportunity/page.tsx`
- `src/components/OpportunityBoard.tsx`
- `src/app/api/jobs/opportunity/route.ts`
- `tests/opportunityClock.test.ts`
- `tests/opportunityBreadth.test.ts`
- `tests/opportunityVelocity.test.ts`

**修改**

- `src/lib/jobs/alphaScreener.ts` — 快照增加 `ranked` 摘要与广度，不改 Discord 卡片语义
- `scripts/run-daily-jobs.ts` — 链上增加 `opportunity`（在 macro-phase 之后，软失败）
- `src/components/SiteNav.tsx` — 「机会」
- `src/app/page.tsx` — 环境区加一行入口，不替换现网账本卡
- `docs/spec-conformance.md` — 日更链说明

**不改**

- `DeskWorkbench.tsx`、`deskScan.ts`、`liveBooks.ts`、`FundWorkbench.tsx` 的写入路径

---

## 阶段 0 — 类型与纯函数（不联网）

快照形状一次定死，后面页面和任务都吃它。

```ts
// src/lib/opportunity/types.ts
import type { SectorClockId, SectorClockStatus } from "@/lib/scoring/sectorClock";

export type OpportunitySectorRow = {
  id: SectorClockId;
  symbol: string;
  name: string;
  rank: number;
  status: SectorClockStatus;
  sls: number;
  mom21: number;
  /** 11 档里的 63 日强弱分位，0–100 */
  rps: number;
  rpsDelta: number | null;
  breadth: { sample: number; strong: number; rising: number } | null;
};

export type OpportunityStock = {
  symbol: string;
  name: string;
  sectorId: SectorClockId | null;
  industryLabel: string;
  rps20: number;
  rps50: number;
  rps120: number;
  rps250: number;
  rpsDelta: number | null;
  inLivePool: boolean;
  elite: boolean;
  newHigh: boolean;
};

export type OpportunityData = {
  asOf: string | null;
  missingSymbols: string[];
  sectors: OpportunitySectorRow[];
  leaders: SectorClockId[];
  bottoming: SectorClockId[];
  pool: OpportunityStock[];
  candidates: OpportunityStock[];
};
```

进度：阶段 0–4 代码已落地。时钟可独立显示；筛选快照有 `ranked` 后才会出现广度/候选。VPS 上需再跑一次带新代码的 `screener:push`，`readSnapshot("screener")` 才不再是 MISSING。

### Task 0.1 时钟行

**Files:** `src/lib/opportunity/clockOf.ts`，`tests/opportunityClock.test.ts`

- [ ] 用 `tests/sectorClock.test.ts` 里同一套走平/单边行情，断言 `clockOf(lastDay)`：
  - 11 行，`id` 与 `SECTOR_UNIVERSE` 一致
  - 走平：`sls ≈ 1`，`rps` 为并列分位
  - TECH 单边上涨：`status === "leader"` 且 rank ≤ 3
- [ ] `clockOf` 只转换，不读盘。`rps` = 11 档 `sls` 的百分位（`percentileRank`）。
- [ ] `npx vitest run tests/opportunityClock.test.ts`

### Task 0.2 广度

**Files:** `src/lib/opportunity/breadthOf.ts`，`tests/opportunityBreadth.test.ts`

输入：每只股票 `{ sectorId, rps250, rpsDelta }`。

- [ ] 规则（写进测试，不要事后改口径）：
  - `strong`：`rps250 >= 80`
  - `rising`：`rpsDelta != null && rpsDelta > 0`
  - 按 `sectorId` 分组；`null` 不入 11 档
- [ ] 测：TECH 10 只里 4 只 ≥80、3 只 delta>0 → `{ sample: 10, strong: 4, rising: 3 }`
- [ ] `npx vitest run tests/opportunityBreadth.test.ts`

### Task 0.3 速度

**Files:** `src/lib/opportunity/velocityOf.ts`，`tests/opportunityVelocity.test.ts`

- [ ] `rpsDelta(today, prev) = today - prev`；缺一侧为 `null`
- [ ] 测：`88 - 80 === 8`；`prev` 缺失 → `null`

---

## 阶段 1 — 行业时钟上线（现成 12 条 CSV）

不依赖筛选。先让网站有一块能看的「机会」。

### Task 1.1 日更任务

**Files:** `src/lib/jobs/opportunity.ts`，`src/lib/dashboard/opportunity.ts`，`src/app/api/jobs/opportunity/route.ts`

- [ ] `runOpportunityClockJob`：`loadDailyBars(["SPY", ...SECTOR_UNIVERSE.symbol])`
- [ ] 缺标的写入 `missingSymbols`，有齐的仍算时钟（和 MPR「缺一个就整页空」不同：11 档缺一档记 0）
- [ ] 对齐交易日：只保留 SPY 与该日至少 8 档有收盘的日子
- [ ] `writeSnapshot("opportunity", data)`；此时 `pool/candidates/breadth` 为空数组/`null`
- [ ] 读函数：`getOpportunityData()`，缺快照返回空壳
- [ ] API 鉴权抄 `src/app/api/jobs/macro-phase/route.ts`
- [ ] 本机：`npx tsx -e` 调任务（或 vitest mock `loadDailyBars`）断言写出 11 行

### Task 1.2 页面 + 导航

**Files:** `src/app/opportunity/page.tsx`，`src/components/OpportunityBoard.tsx`，`src/components/SiteNav.tsx`

- [ ] 导航在「市场雷达」前加 `{ href: "/opportunity", label: "机会" }`
- [ ] 页题：机会。副标题：行业抬头与现网池对照。不改买点，不改账本。
- [ ] 先画 11 档：名称、状态中文（领涨/回流/中性/流出）、SLS、21 日超额、行业 RPS
- [ ] 空快照：提示去跑日更，不要假数据
- [ ] `revalidate = 300`，与雷达页相同
- [ ] 打开 `/opportunity` 应 200，无「能不能重仓」

### Task 1.3 总览入口

**Files:** `src/app/page.tsx`

- [ ] 「环境」下加第二行，链到 `/opportunity`，文案：改池时看行业，不指挥现网仓位
- [ ] 现网两张账本卡一字不改

---

## 阶段 2 — 筛选快照落到 VPS

### Task 2.1 扩大筛选落盘

**Files:** `src/lib/jobs/alphaScreener.ts`

现在 `writeSnapshot("screener", { date, ...result })` 只在 runner 本地。改成与 mpr 相同的 `snapshots/screener.json` 结构，并**多写**页面要用的摘要（Discord 仍只用 `elite` / `newHighs`）：

```ts
type ScreenerSnapshot = {
  date: string;
  universeSize: number;
  rankedSize: number;
  baseThreshold: number;
  elite: ScreenerRow[];
  newHighs: ScreenerRow[];
  dailyFetchErrors: number;
  /** 全截面，供广度与对照；不要 AI 正文 */
  ranked: Array<{
    symbol: string;
    name: string;
    sector: string | null;
    industry: string | null;
    industryLabel: string;
    rps: Record<20 | 50 | 120 | 250, number>;
    prevRps250: number | null;
  }>;
};
```

- [ ] `prevRps250`：用同一批日线、收益窗口右端前移 5 个交易日，再做一次百分位
- [ ] 单测：3 只假行情，T 与 T-5 排名对调，delta 符号正确
- [ ] Discord 推送函数签名不变

### Task 2.2 日更链

**Files:** `scripts/run-daily-jobs.ts`，`docs/spec-conformance.md`

```
macro-phase → rotation-radar → opportunity → fund-score
```

- [ ] `opportunity`：**先**跑时钟（12 条 CSV，快）；若 `screener` 快照当天已有，合并进 `opportunity.json` 的 candidates/breadth
- [ ] `fund-score` 继续 soft
- [ ] `opportunity` 也 soft：时钟失败不应拖垮账本链
- [ ] VPS 上 `screener:push` 必须写到行情机 `snapshots/`（与 `MARKET_DATA_DIR` / 远程写盘对齐，不要只写 GitHub runner）

核对：`readSnapshot("screener")` 在 `MARKET_DATA_BASE_URL` 下不再是 MISSING。

---

## 阶段 3 — 广度 + 候选上页

### Task 3.1 合并进 opportunity 快照

**Files:** `src/lib/jobs/opportunity.ts`，`src/lib/opportunity/breadthOf.ts`

- [ ] 读 `screener.ranked`，`mapSectorToClock(sector)`，算 11 档 breadth
- [ ] `candidates` = elite ∪ newHighs，带 `rpsDelta`、`sectorId`
- [ ] 无 screener 时页面仍显示时钟，候选区写「今日截面未生成」

### Task 3.2 UI

**Files:** `src/components/OpportunityBoard.tsx`

- [ ] 每档显示 `强势 a / 样本 b`、`抬头 c`
- [ ] 「今日候选」表：代码、行业、RPS250、Δ、是否新高；点代码只链 `/desk`（不自动加池）
- [ ] 明确：不是现网账本

---

## 阶段 4 — 现网池对照

### Task 4.1 行业映射

**Files:** `src/lib/opportunity/extraSectors.ts`，`src/lib/opportunity/poolOverlay.ts`

- [ ] `extraSectors`：现网常见非标普（如 RKLB、IONQ、IREN、NBIS、ASTS、HUT、CRWV）→ `{ sector, industry }`，来源公开 GICS/公司简介
- [ ] `overlayPool(members, spx, extra, ranked)`：
  - 先 SPX，再 extra，再 ranked 里的 sector
  - 都没有 → `sectorId: null`，`industryLabel: "未分类"`
  - `inLivePool: true`
  - RPS 优先用 ranked；不在标普截面里的 RPS 留空，不现场跑引擎
- [ ] 单测：NVDA→TECH，RKLB→INDU（或 extra 里写的档），ZZZZ→未分类

### Task 4.2 日更写入 pool

**Files:** `src/lib/jobs/opportunity.ts`

- [ ] `readSignalPoolMembers()` 只读
- [ ] 快照 `pool` 字段
- [ ] 页面「现网池」按 11 档分组，未分类单独一列
- [ ] 不提供「一键纳入」

---

## 阶段 5 — 收口

- [ ] 总览环境行带上领涨/回流各一档名字（来自 opportunity 快照）
- [ ] `npx tsc --noEmit`、`npx vitest run tests/opportunityClock.test.ts tests/opportunityBreadth.test.ts tests/opportunityVelocity.test.ts tests/sectorClock.test.ts`
- [ ] 手工：`/`、`/opportunity`、`/desk`、`/fund` 现网数字与改池行为与改前一致
- [ ] 更新 `docs/spec-conformance.md` 日更链

---

## 明确不做（本计划外）

- 自动改股票池、walk-forward 回测页
- 新的行业速度/加速度公式（时钟的 21 日超额 + 个股 ΔRPS250 已覆盖「正在变强」）
- 把轮动或 MPR 接进现网池
- 改 4H/2H 定档

## 验收

1. `/opportunity` 在无筛选快照时仍能显示 11 档时钟。
2. 有筛选快照后出现广度、候选、现网分档。
3. `/desk`、`/fund` 买卖与改池与现在相同。
4. 日更缺 FMP / 缺筛选时，时钟仍更新。
