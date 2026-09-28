# 历史遗留清理 · 2026-09-28

## 范围与依据

清理前版本：`7a57507b78d371a19534495d41a3a4856573b3e0`。先按 TypeScript 导入图检查页面、API、全部脚本与测试，再全文检查文件名、导出函数和动态资源路径。静态不可达不能单独证明可以删除；历史兼容、资源读取、手动工具与原始数据另外保留。

## 已清理

- 三个未引用组件：`LiveBookCard.tsx`、`ReportMarkdown.tsx`、`StatusBadge.tsx`。`FundBoard` 中仍被使用的同名内嵌账本组件未改动。
- 未使用的旧辅助模块：`commercialSpec`、`earlyBreakeven`、`deepseekScreenerCoach`、`data-sources/sec`、`rpsLeaderboardWebhook`、`scoring/format`。
- 仅旧测试使用的模块：`deskLedger`、`sleeveBlend`、`finra`、`optionFlow/recap`，以及旧 `environment/execution/killSwitch/macro/momentumGates/mprAlphaRs/relativeRs/sector/stock/stockQuality/valuation` 评分链。
- 同步移除只覆盖已删除功能的测试；保留混合测试文件中的现有信号扫描与 RPS 排名断言。
- 从 `jobs:daily` 去掉没有当前消费者的 `fund-score` 快照任务，移除旧在线查询服务。历史财务评分计算、旧信号字段、SEC Company Facts 与离线研究脚本保留；`distFrom52w` 移至历史评分纯函数模块，算法不变。
- 移除未使用的直接依赖：`@tabler/icons-react`、`clsx`、`date-fns`、`framer-motion`、`react-markdown`、`remark-gfm`、`tailwind-merge`。组件库自身依赖的 `clsx` 仍由锁文件保留。
- 原根目录 PDF / DOCX 和四份初始设计文件迁移到 `docs/archive/market-compass/`，重写项目 README。

## 为保护现有功能而保留

- 每日行情、MPR 宏观相变、机会计算、账户计算、复盘与图片、选股、Telegram / Discord 推送的入口和定时频率。
- 现行与历史信号评分、模型账本历史版本、日期校验、补采、失败重试与推送去重。
- `/mpr`、`/rotation` 等旧链接跳转。
- Theta / PDE 研究代码与结果、行情 CSV、期权数据、历史快照、研究面板缓存、已有预览成品。
- Logo 和字体的网页与服务端出图副本，各有实际消费者。
- `@mantine/hooks` 等 peer 依赖。第一阶段保留 Prisma / pg 工具链；用户随后明确要求全部移除，第二阶段结果见文末。

## 缓存清理边界

只清理确认没有活动 Node / Next 服务使用的可重建目录，逐项记录结果。不对 `.cache/`、`.tmp/`、`data/` 整体删除；里面含采集原件、研究结果和用户预览。未停止服务或修改线上快照。

| 已删除路径 | 文件逻辑大小 |
| --- | ---: |
| `.next/` | 4,210,220,683 B |
| `.cache/theme-preview-20260924/` | 219,725,813 B |
| `.cache/uv/` | 416,301,584 B |
| `.tmp/pdf-venv/` | 72,337,303 B |
| `tsconfig.tsbuildinfo`、`.DS_Store` | 536,140 B |
| 合计 | 4,919,121,523 B（约 4.9 GB） |

清理前确认保留的 Theta 虚拟环境没有指向 uv 缓存的符号链接。上述为被清理文件的逻辑大小；硬链接、文件系统共享及随后重新构建生成的 `.next/` 会影响实际释放空间。

## 第一阶段验证记录

清理前基线：130 个测试文件通过；3 个文件失败，其中两个因沙箱不允许监听本地端口，一个现有服务端渲染测试漏包 `MantineProvider`。后者只修正测试环境，产品组件不变。

清理后检查：

- `npm run typecheck` 通过。
- 允许本地 HTTP 测试监听后，完整 Vitest 回归：**126 个测试文件、1175 项测试全部通过**。
- 所有修改的 TypeScript 文件 ESLint 通过，`git diff --check` 通过。
- `VERCEL=1 npm run build` 成功，页面与 API 路由正常产出；构建日志确认跳过 RPS 重算。构建仍有 5 条来自未修改文件的动态路径追踪警告，涉及信号存储、行情目录与事件股票池；本次未扩大范围重构这些读取逻辑。
- 锁文件删除 104 个依赖包条目，没有新增包，也没有改变保留依赖的版本。
- 10 份归档文档逐字节校验与清理前 Git 内容一致。
- `src/app/`、`deploy/`、`.github/` 没有改动；原始数据、Theta 环境、研究缓存与预览目录仍保留。

第一阶段仅去掉每日辅助任务中无消费者的旧基本面快照步骤，其余入口与调度保持原样；后续数据库入口清理见下文。

删除源码的原内容可通过上述 Git 版本按原路径取回。历史文档已直接保留，无需从 Git 恢复。


## 第二阶段：完整移除 Prisma / PostgreSQL

用户追加授权：“都移除”，同时继续遵守“不影响现在的功能和任务”。

### 移除范围

- 删除 `prisma/schema.prisma`、`prisma.config.ts`、生成的客户端和 `src/lib/db/`。
- 移除 `@prisma/adapter-pg`、`@prisma/client`、`prisma`、`pg`、`@types/pg`，本阶段删除 128 个依赖包条目，保留依赖没有升级或新增。
- 构建不再执行 `prisma generate`；删除相关 npm 命令、示例环境变量和无调用方的数据库面板回退函数。
- 删除已经指向停用数据库的 `/api/jobs/refresh-market-panel`、`/api/jobs/rps-leaderboard` 及对应任务实现。
- 删除数据库导入、回填、刷新脚本 7 个，以及仓库中的 PostgreSQL 部署目录和一次性数据库迁移 workflow。没有连接或删除服务器上的数据库、容器或数据卷。
- 更新当前 README 与代码说明。历史设计文档保留历史记载，不作为当前部署说明。

### 现有能力的保留方式

| 原入口 | 处理 |
| --- | --- |
| `lab`、`lab:search` | 原来已经读文件，仅移除末尾无用的数据库断连调用 |
| `backtest:portfolio`、`backtest:rotation` | 使用 `loadDailyBars` 读取本地 / VPS 日线；计算和统计规则保留 |
| `calibrate:mpr`、`calibrate:rotation`、`compare:mpr`、入场消融脚本 | 使用相同日线读取器；宏观数据缺失时明确报错 |
| 已退役的数据库 `backfill:*` / `panel:refresh` / 导入命令 | 删除；日常行情继续用 `market:refresh`，研究面板用 `panel:cache` / `panel:fetch` |
| 日更 / 复盘 / 账本 / GEX / TradingView / DC / TG | 现有文件服务链路与定时配置保持不变 |

### 最终验证

- 全部 **126 个测试文件、1174 项测试通过**。相较第一阶段少 1 项，是已删除数据库开关对应的测试；保留 Small Fund 文件数据源测试。
- 类型检查、修改文件 ESLint、`git diff --check` 均通过。
- 在 Prisma 依赖和生成目录都不存在的条件下，`VERCEL=1 npm run build` 成功。仍有前述 5 条动态路径追踪警告。
- 固定生成 49 个标的、每个 620 根日线的合成测试行情：旧脚本使用返回同一数据的测试数据库适配器，新脚本使用 CSV。8 个研究入口、9 种运行方式均以退出码 0 完成；排除耗时字段后，计算输出逐字一致。覆盖实验室默认与参数扫描、稳定性扫描、交易/组合回测、两类校准、MPR CSV 对拍及入场消融。该检查证明固定输入上的迁移一致性，不是策略收益回测或对真实历史价格精度的承诺。
- 另一个没有 MACD 一买的合成样本在旧版与新版入场消融脚本中均触发空样本统计错误。这是该研究工具原有的边界情况，本次没有扩大范围改变统计逻辑。
- 源码、脚本、构建和当前部署配置不再引用 Prisma、PostgreSQL 客户端或数据库连接变量；锁文件无相关依赖包。现有防止 Prisma 重新进入选股日更脚本的检查仍保留。
- `deploy/market-http/` 与现行定时器没有改动，原始行情、快照、研究缓存和模型账本未改写。

以上记录对应第二阶段完成时的验证。后续已完成 VPS 私有配置迁移与生产部署，最新配置和上线状态见 [环境配置说明](environment.md)。各阶段验证均没有触发真实推送。
