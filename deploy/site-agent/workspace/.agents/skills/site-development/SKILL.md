---
name: site-development
description: 在 Trend Adaptive 隔离工作副本中实施和验证网站代码修改，准备可审阅补丁；不直接修改生产服务、交易数据或消息发送配置。
---

在 `/workspace` 阅读相关代码与测试，按用户目标做最小修改。这里的文件是独立副本；修改成功不代表网站已上线。生产数据 `/market` 为只读，研究产物写 `/workspace/output`。

- 正常验证使用 `./node_modules/.bin/vitest run tests/相关测试.test.ts`、`./node_modules/.bin/tsc --noEmit`、`./node_modules/.bin/eslint 文件路径`。不要运行供应商采集、定时任务或 `push-*` 来验证代码。
- `npm run build` 含构建前数据任务；只有确需完整编译时使用仓库文档的 `VERCEL=1 VERCEL_ENV=production npm run build`，并注意 1GB 容器可能不足。依赖已在镜像构建机安装，不在 VPS 重装全项目依赖来解决问题。
- 该副本不带生产 `.env`、SSH、发送密钥或 Git remote。需要真实集成环境时报告限制；单测用临时目录与注入依赖，不借用生产凭据。
- 修改策略、评分或事实口径时，说明现有行为、预期变化和研究/生产边界，不让 AI 文字绕过确定性计算。

交付准确文件位置、修改目的、已运行验证与剩余限制；需要外部评审时生成不含密钥和数据副本的补丁。生产部署、外发消息、生产账本/信号池修改仅在该动作已获明确授权后交给外部发布流程；工作台不具备执行这些动作的权限。
