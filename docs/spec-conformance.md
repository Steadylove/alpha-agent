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

## 三、未实现项

### short interest 驱动的轧空放大

Compass Pine 的 `target_atr_st` 会根据 short interest 百分比放大目标价倍数。FMP 的 stable API 不提供 short interest，Yahoo 的 `quoteSummary` 需要 crumb/cookie 绕行且很脆弱。

`shortTermTarget` 已实现，但 `squeeze_mult` 恒为 1.0、tier 恒为 `swing`——这正是 Pine 在数据为 `na` 时的 fallback 分支，所以行为是对的，只是永远走不到放大分支。目标价 = `close + 2 × ATR`，仍是有效的 ATR 投影，只是没有轧空维度。

拿到 short interest 数据源后这一项可以直接激活，代码路径已经在了。

### MarketCompass 的 MPR 变体

Compass Pine 里内嵌了一套简化版 MPR，与 MPR Pine 的完整版口径不同。没有单独建模块——两套并存只会让用户困惑，且完整版是超集。差异点记录在此，不做实现。

## 四、验证

- `npx tsc --noEmit`
- `npx vitest run`（386 项）
- `npx eslint .`
