# Fundamental Website Summary and Entry Link Implementation Plan

**Goal:** 在网站买点展示已保存估值摘要，并从真实信号时间、账本模拟开仓时间查询当时可知的版本。

**Architecture:** 新增只读批量摘要接口，读取最新快照而不读完整历史；2H/4H 共用同一股票估值。独立详情继续使用既有 `entryAt` 查询和防未来数据规则。界面明确区分最新估值、信号时估值和模拟入场时估值。

**Tech Stack:** Next.js / React / TypeScript / Vitest / 现有本地快照。

## Boundary

- 不调用 FMP 或 AI，不修改估值公式、信号、账户计算、Discord/Telegram 推送，不部署。
- `JournalSignal.signalTime` 是毫秒 epoch；账本 `entryDate` / 买入 `fill.date` 是 UTC K 线开盘时刻（允许存储中省略 Z）。仅日期或无效时间不补为午夜。
- 信号台 `asOf` 是 K 线开始标记，不冒充精确信号收盘时间。其持仓可使用已有模拟入场时间；只有本根信号而无持仓时，仅展示最新估值并说明历史时间未留档。

## Tasks

- [x] `src/lib/fundamental/store.ts`, `summary.ts`, `types.ts` 和 `src/app/api/fundamental/summary/route.ts`：提供最多 20 股票的只读精简摘要；读取失败逐股票隔离，缺数据明确返回；不加载历史版本。用 API / store 测试验证。
- [x] `src/components/fundamental/entryContext.ts`：严格规范化 UTC 账本时间、毫秒信号时间和带时区 entryAt；构造编码链接。测试夏令时、日期缺失、非法日期和偏移时区。
- [x] `FundamentalSummary.tsx`, `useFundamentalSummaries.ts`, 样式：展示 6M/12M 目标、情景区间、相对留档报价空间、状态、报价/版本日期；标注最新值非历史已知，失效估值标旧版。逐批只读接口；失败不影响原页面。
- [x] `DeskWorkbench.tsx`, `FundamentalDrawer.tsx`：接摘要和周期持仓历史入口，Drawer 以 symbol + entryAt 区分请求，完整页保留上下文。
- [x] `DailyReview.tsx`, `FundBoard.tsx`：买点摘要与实际 signalTime 关联；持仓和模拟买入成交使用各自 entryDate/date 链接（卖出不误当入场）。旧账本只读入口也可查询。
- [x] `FundamentalPanel.tsx`：传入 entryAt 时主动展示历史核对状态，与最新值区分；缺当时版本不得回填。
- [x] 验证：`npx vitest run tests/fundamental*.test.ts`、相关账本/复盘测试、`npm run typecheck`、变更文件 lint、浏览器桌面/移动端与同股票切时间检查。更新模块文档。

当前工作区包含此前尚未提交的基本面模块；沿用本地开发，不复制或提交不相关文件。

## Validation results

- 21 个测试文件、194 项测试通过（基本面全组及信号台、复盘、账本相关组）。
- TypeScript 与变更文件 lint 检查；原信号台 mount 扫描保留既有行为并标注 effect lint 例外。
- 独立代码审查未发现阻断问题。浏览器使用本地 ACME 演示快照：摘要有值 / 无留档、同股票两种历史时点切换及 390px 手机布局通过。临时验证路由已删除。
- 未请求外部金融或 AI 数据，未提交、推送或部署。真实数据验收继续等待数据源问题处理。
