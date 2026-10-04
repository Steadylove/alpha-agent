---
name: site-diagnostics
description: 在隔离工作副本中诊断 Trend Adaptive 页面、数据新鲜度、复盘引用和服务边界的问题；不会自动触发生产刷新、推送或部署。
---

先记录症状、目标页面/标的/交易日和期望结果，再用只读证据定位到采集、归档、读取、校验或展示层。通过 `node /opt/site-agent/scripts/site-data.mjs` 查看已挂载数据，保存来源与时间；不要重跑日更脚本来验证症状。

关键边界：

- Vercel 网页通常读取 VPS snapshots；查 `src/lib/vps/snapshot.ts` 和相关模块 store。远程失败不应退回构建时旧快照。
- 复盘解读用 `sourceHash`、`inputHash`、提示词版本与证据引用判定一致性；源快照更新可能使旧解读 stale。基本面已保存状态还有 `checkedAt` 与 `validUntil`。
- 模型账本重算、信号池修改、job 路由及消息发送都有副作用；HTTP GET 不是只读保证。只调用明确的读取器，禁止为诊断访问 `/api/jobs/*`。
- 工作台无法看宿主机 systemd 日志、生产环境变量或 Docker。需要这些信息时说明确切缺口，不把“不可见”写成“故障”。不要尝试读取登录凭据或扩大挂载。

如果需要修复，在隔离副本给出根因、最小修改、针对性测试与未验证边界。涉及部署或生产数据更正时形成可审阅方案，实际操作交给已明确授权的发布流程。
