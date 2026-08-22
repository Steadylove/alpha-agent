# 四份规格的实现对照

记录 `轻量级量化投研/` 下四份文档的落地情况：哪些照搬、哪些改了、哪些没做以及为什么。

四份文档分别是：

| 简称 | 文件 | 性质 |
| --- | --- | --- |
| 轮动 Pine | `美股动能满仓轮动雷达 (全口径NAV精准核算·旗舰版) 1.txt` | 可执行 |
| MPR Pine | `Market Phase Radar - 市场相变雷达 (专业交易版).txt` | 可执行 |
| Compass Pine | `MarketCompass量化估值与市场相变决策系统.txt` | 可执行 |
| 商业化文档 | `商业化产品架构闭环（三层决策漏斗）.txt` | 产品愿景，无代码 |

**总口径：Pine 为准。** 三份 Pine 是能在 TradingView 上跑出图的东西，商业化文档是一份还没被验证过的设计稿。两者冲突时按 Pine 实现，商业化的说法做成默认关闭的开关（见 `src/lib/config/commercialSpec.ts`），需要时逐项打开。

## 一、四处直接冲突

### 1. RS 算法：截面分位 vs 逐股饱和映射

商业化文档第 146 行要求 `RS_i = PercentileRank(AlphaScore_i, Universe)`，即全池截面排名。三份 Pine 用的都是逐股独立的饱和映射——一只股票的分数只取决于它自己相对基准的表现，与池子里其他股票无关。

Pine 拿不到全池数据（TradingView 单图表限制），这个差异是环境造成的而非设计分歧。项目里两套都有：

- 生产路径用饱和映射（`relativeRs.ts`、`mprAlphaRs.ts`），与 Pine 一致
- 截面分位实现在 `percentileRs.ts`，开关 `COMMERCIAL_SPEC.percentileRs` 默认关

两者的实质区别是：同样的绝对涨幅，在强势市场里截面 RS 会给更低的分。这不是精度问题，是两种不同的选股哲学。

### 2. 入场门槛：RS≥70 / RS<40 一票否决

商业化文档第 148~152 行的硬门槛。**两份 Pine 都没有这条**——轮动 Pine 只有一个默认关闭的 `RSI > 30` 过滤，跟 RS 评分完全是两回事。

项目现状是 `minRs = 30`，这个数**既不在 Pine 里也不在商业化文档里**，是回测校准出来的自加项：30 是唯一让胜率、均值、盈亏比三项同时改善的档位（629 笔 52.8%/+7.07%/2.47 → 508 笔 53.7%/+7.24%/2.70）。往上加会适得其反，RS≥45 砍掉 69% 的成交而均值反降到 +6.32%。

商业化版本实现为 `COMMERCIAL_SPEC.rsEntryVeto`，默认关。

### 3. 保本触发：+5% 提前档

商业化文档第 217 行：常态 +10%，但 Path 2 或 5 日下跌概率 ≥60% 时提前到 +5%。两份 Pine 都只有 +10%。

实现在 `rotationTrade.ts` 与 `stockRisk.ts` 的 `useEarlyBreakeven`，宏观条件由调用方通过 `earlyBreakevenActive(index)` 注入，默认关。

### 4. 组合权重：E_macro 敞口缩放

商业化文档要求 `W_i = E_macro(Path) × RS_i/ΣRS_j`，Pine 只有 `RS_i/ΣRS_j`。

**这一项有反向证据。** 组合层回测（3927 日、已去除未来函数）显示照 E_macro 机械减仓会让收益/波动从 1.18 降到 0.95。已实现为 `COMMERCIAL_SPEC.macroExposureScaling`，默认关；打开前请重跑回测。

## 二、Pine 内部的矛盾与死代码

### 低吸带的 `upside >= 15%` 门槛是死代码

Compass Pine 里先算了一个带 15% 上行空间门槛的低吸带，但紧接着的每个 stage 分支都会无条件覆写它，这个门槛实际上永远不生效。

按 Pine 的**实际行为**实现（门槛不参与计算），同时在 UI 上把 upside<15% 做成提示性标注，让用户看得到这个信息但不改变信号。

### 阶段消歧的两套优先级

Compass Pine 的显示阶段和低吸带用的阶段走的是不同的优先级链。低吸带用 A>E>D>W>C，与显示阶段不同。实测两者有 7.35% 的日子会分歧，主要是显示 Stage W（震荡）但低吸逻辑该用 Stage E（混沌筑底）的情况。

`stockStage.ts` 暴露原始 `StageFlags`，`dipStageOf()` 单独实现低吸口径。

### MPR 的 `act_text` 与本项目的证据结论相反

MPR Pine 的 `act_text` 会根据 Path 给出明确的方向性和仓位建议。但本项目对 MPR 路径做过校准，结论是**没有预测力**，因此 `mprReading.ts` 刻意不给方向性建议。

两者都保留：`mprGuidance.ts` 忠实移植了 Pine 原文并在 UI 上标为「原版指引」，`mprReading.ts` 的证据结论并列展示，附上预测力的说明。用户看得到原版说了什么，也看得到我们为什么不照做。

## 三、数据源替换

### short interest 走 FINRA + SEC，而非 Pine 的 TradingView 财务字段

Compass Pine 用 `request.financial(..., "SHORT_INTEREST", "FQ")`，这是 TradingView 的季度财务字段，项目外拿不到。替换为两个免费源：

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 空头持仓股数 | FINRA `consolidatedShortInterest` | 免费无鉴权，覆盖全美股 22341 只，轮动池 40 只无缺口 |
| 在外股本 | SEC XBRL companyconcept / companyfacts | 免费，需 User-Agent；仅 ETF 无申报 |

**比 Pine 原版更新鲜**：Pine 是季度口径，FINRA 是双月度（每月 15 日与月末结算，结算后第 7 个交易日发布，滞后 2~3 周）。

实测轮动池档位分布：`extreme` 2 只（IREN 27.5%、ASTS 19.0%）、`warning` 3 只（IONQ 13.2%、CRWD 10.0%、LITE 9.5%）、其余 `swing`。大盘股普遍在 1% 上下。

两个实现细节值得记一笔：

- SEC 在概念不存在时返回 **HTTP 200 但 body 是 XML**，只看 `res.ok` 会踩空
- 多类别股公司（META、GOOG）不报封面页合计股数，只能回落到加权平均稀释股本。这类都是万亿级大盘、空头占比约 1%，离 8% 档差一个数量级，近似误差不改变档位

**已知失真：** 发过大额可转债的标的（IREN、NBIS），空头持仓里含做市商的中性对冲仓，不是方向性空头，占比会系统性虚高。Pine 的算法照实移植，UI 上对 >=8% 的标的给出提示，判断留给使用者。

### MarketCompass 的 MPR 变体（未实现）

Compass Pine 里内嵌了一套简化版 MPR，与 MPR Pine 的完整版口径不同。没有单独建模块——两套并存只会让用户困惑，且完整版是超集。差异点记录在此，不做实现。

## 四、验证

- `npx tsc --noEmit`
- `npx vitest run`（396 项）
- `npx eslint .`

空头持仓由 `short-interest` 任务刷新，双月一期，已有当期数据时自动跳过回源。

## 五、每日调度

`.github/workflows/daily-quant-jobs.yml`，00:30 UTC 周二至周六（美股收盘后约 4.5 小时，日线已定稿）。

先跑三个 backfill 补日线，再由 `npm run jobs:daily` 按依赖顺序执行：

```
macro-phase → short-interest → rotation-radar → stock-panel → stock-valuation
```

顺序约束有两条：`macro-phase` 的产出被后面三个读取（低吸带 Path 4 冻结、估值的 fsmState/pathId、提前保本的宏观条件）；`short-interest` 必须早于 `stock-valuation`，否则轧空档位读到上一期。

`short-interest` 是唯一的软失败步骤——它依赖 FINRA 与 SEC 两个外部免费接口且双月才换一期，挂掉时估值沿用上一期缓存即可，不该拖垮整条链。

### 调度相关的已知问题

- **日线更新用 `skipDuplicates`,不修正历史。** 发生拆股时旧价不会被重算，需手工清库重跑 backfill。这是 backfill 脚本的既有设计，不是调度引入的
- **`backfill:sectors` 的行业归属部分对全部 40 只标的报「FMP 无行业数据」**，当前订阅不覆盖该接口。ETF 日线正常，板块时钟走的是 `SECTOR_UNIVERSE` 而非逐股归属，因此不受影响；脚本退出码为 0，不会中断 workflow
