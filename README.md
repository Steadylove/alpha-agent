# TREND ADAPTIVE

美股市场观察与策略研究系统：每日复盘、2H/4H 买卖点、现金模型账本、板块与个股强度、异常期权流、事件观察及 Discord / Telegram 推送。

## 本地启动

```bash
npm ci
cp .env.example .env
npm run dev -- --port 3107
```

按实际环境填写 `.env`，不要覆盖已有密钥。需要本机覆盖时用 `.env.local`；网页与 Node CLI 使用一致的文件优先级。公开配置统一修改 `app.config.ts`；Vercel 生产密钥通过服务身份读取 VPS 私有 `web-secrets.json`，不在网页配置业务变量。配置说明见 [环境变量说明](docs/environment.md)，修改后运行 `npm run env:check`。当前行情、复盘与账本走 VPS 文件服务或本地文件，不依赖运行时数据库。

- `MARKET_DATA_BASE_URL`：VPS 行情与快照服务地址；远程配置存在时优先读取远程数据。
- `MARKET_DATA_DIR`：离线运行及采集任务的本地行情目录。
- 本地 `data/`、`.cache/`、`.tmp/` 不提交 Git；缺行情时同步已有数据或运行对应采集命令。
- 已移除 Prisma / PostgreSQL 依赖，构建和运行均无需 `DATABASE_URL`。历史数据库导入与迁移工具已退役。

## 网页模块

| 路径 | 功能 |
| --- | --- |
| `/`、`/review` | 每日复盘、历史日期、市场状态、期权结构、板块强度、信号验证、明日观察与 AI 解读 |
| `/desk` | 当前股票池的 2H / 4H 信号状态与行情图 |
| `/fund` | 连续现金模型账本、股票池管理、历史版本与临时回看 |
| `/opportunity` | 行业时钟、个股强度、候选股票与现有股票池对照 |
| `/flow` | 异常期权流样本、集中度、强度关联与后续股价跟踪 |
| `/catalyst` | 新闻、未来事件日历、事件后的市场反应 |
| `/context/[symbol]` | 个股事件、异常流、信号和持仓证据的关联观察 |
| `/lab` | 已保存策略方案的回测与对照 |
| `/push` | 推送类型、Discord / Telegram 接收位置和期权大单金额门槛 |

旧 `/mpr`、`/rotation` 路径保留跳转，兼容已有书签。账户为模型账本；系统未接入券商自动下单。

## 数据与定时任务

生产调度位于 `deploy/market-http/cron/`，以下时间除注明外均为北京时间：

| 任务 | 调度 | 内容 |
| --- | --- | --- |
| `alpha-daily-quant` | 周二至周六 08:30 | 行情、RPS、期权流研究、宏观相变及机会快照、GEX、账户、复盘、图片与选股推送 |
| `alpha-review-macro` | 每日 12:30 | 补采宏观数据并补充最近复盘 |
| `alpha-catalyst` | 每小时 07、37 分 | 事件采集、市场反应与关联证据更新 |
| `alpha-catalyst-analysis` | 周二至周六 10:05、每日 12:55、美东周一至周五 08:55 | 独立文字解读与复盘补充 |
| 期权流 worker | 常驻轮询 | 收录来源消息，按网页路由和金额门槛推送 |
| TradingView webhook | 告警触发 | 2H / 4H 买卖点、入场评分留档和图卡推送 |

股票与 ETF 行情以 Alpaca 为主；指数及宏观数据来自 Yahoo、Cboe、美国财政部等，FRED 为利率备用。GEX 来自 Cboe 延时期权链计算。新闻与日历来自 Alpaca、Nasdaq、BLS、BEA、美联储等，缺项保留来源状态。

`npm run jobs:daily` 只负责宏观相变与机会快照，不等于完整的收盘任务。旧 `fund-score` 日更已移除；历史评分兼容和 SEC 离线研究仍保留。日常选股推送仍由 `screener:push` 执行。

## 研究工具与数据入口

- `lab`、`lab:search` 保留现有回测与搜参逻辑；Small Fund 读取本地 / VPS CSV，标普 / 纳指池读取 `.cache/backtest-panel.v8`。
- `backtest:portfolio`、`backtest:rotation`、`calibrate:mpr`、`calibrate:rotation`、`compare:mpr` 及入场消融脚本统一使用现有日线 CSV 读取器。需要对应标的的足够历史，缺少宏观标的会明确报错。
- 行情更新使用 `market:refresh`；完整历史面板使用 `panel:cache` 重建或 `panel:fetch` 下载。
- 原 `backfill:*`、`membership:import`、`smallfund:import`、`panel:refresh` 数据库命令，以及 `/api/jobs/rps-leaderboard`、`/api/jobs/refresh-market-panel` 旧接口已删除。当前定时任务不使用这些入口。

## 构建与检查

```bash
npm run env:check
npm run typecheck
npm test
npm run build
```

Vercel 构建跳过本地 RPS 重算，运行时读取 VPS；不要将整池 CSV 打包进 Serverless Function。只验证生产编译、避免改写本地 RPS 时，可运行 `VERCEL=1 VERCEL_ENV=production npm run build`。HTTP 集成测试需要允许监听本地回环端口。

## 文档与历史资料

- [每日复盘](docs/daily-review.md) · [复盘解读](docs/daily-review-analysis.md) · [日报图片](docs/daily-review-cards.md)
- [V5 五因子评分](docs/signal-assessment-v5.md) · [账本管理](docs/book-management.md) · [Telegram](docs/telegram.md)
- [期权流研究](docs/flow-research.md) · [事件观察](docs/catalyst-monitor.md) · [Context](docs/context-layer.md)
- [Theta 本地研究服务](docs/thetadata-local-service.md)：与每日生产任务分开。
- [旧白皮书与初始设计](docs/archive/market-compass/README.md)：历史参考，不作为当前部署指引。
- [本次清理记录](docs/repository-cleanup-2026-09-28.md)

仅供信息参考，不构成投资建议。
