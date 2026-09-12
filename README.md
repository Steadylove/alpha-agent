# Market Compass

美股中短线波段分析：公开数据源采集、量化评分、Discord 推送和 Next.js 前端看板。

## 本地启动

```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run dev
```

## 每日任务

VPS cron 跑 `npm run jobs:daily`（宏观相变、轮动雷达、基本面评分）以及账本、GEX、筛选推送。

## 傻瓜式部署（Vercel）

1. GitHub 连上这个仓库，Vercel Import，环境变量按 `.env.example` 填（至少 `DATABASE_URL`、`PANEL_SNAPSHOT_URL`）。
2. `git push`。构建会检查 `data/smallfund/*.csv` 和 `data/benchmarks/SPY.csv`，并打进实验室函数包。
3. 打开 `/lab`。Small Fund 读仓库里的 CSV，不依赖线上再拉 Yahoo。

本地缺 CSV 时：`npm run smallfund:fetch`，再开一次 `/lab` 会自动落下 SPY。这两份目录要提交进 git，否则线上读不到。

## 数据源

- 行情：Stooq，失败后尝试 Yahoo Finance chart endpoint
- 基本面：Financial Modeling Prep 免费 API Key
- 宏观：FRED API，可选
- 推送：Discord Webhook

免责声明：本工具仅供量化数据及估值模型教学演示，不构成任何投资建议。
