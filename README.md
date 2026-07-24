# Market Compass

美股中短线波段分析 MVP：公开数据源采集、量化评分、中文日报、Discord 推送和 Next.js 前端看板。

## 本地启动

```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run dev
```

未配置 `DATABASE_URL` 时，前端会使用 demo fallback 数据，方便先查看界面。

## 每日任务

配置数据库和 `CRON_SECRET` 后，可以手动触发：

```bash
curl -X POST http://localhost:3000/api/jobs/daily-report \
  -H "x-cron-secret: $CRON_SECRET"
```

部署到 Vercel 时，可用 Vercel Cron 调用 `/api/jobs/daily-report`，并在请求头携带 `x-cron-secret`。

## 数据源

- 行情：Stooq，失败后尝试 Yahoo Finance chart endpoint
- 基本面：Financial Modeling Prep 免费 API Key
- 宏观：FRED API，可选
- 推送：Discord Webhook

免责声明：本工具仅供量化数据及估值模型教学演示，不构成任何投资建议。
