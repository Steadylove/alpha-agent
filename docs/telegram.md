# Telegram 信号同步

项目产生的买卖信号、4H/2H 现金账本、GEX 与市场状态卡片同时发送到 Discord 和 Telegram。图片只渲染一次，两个平台使用同一份内容。Discord 中其他人手动发送的消息不在同步范围。

## 群里怎么用

把机器人加入普通群或超级群，允许发送文字和图片，即自动订阅之后的新信号。无需登记群 ID，保留 Telegram 隐私模式即可。暂不支持频道和私聊广播。

- `/status`：查看本群接收状态。
- `/pause`：暂停本群推送，仅群管理员可用。
- `/resume` 或 `/start`：开启接收，仅群管理员可用。
- `/help`：使用说明。多个机器人同群时可加 `@机器人用户名`。

离群会取消该群待发信号；重新加入可以重新订阅。暂停后恢复只接收新信号。原先已在群里的机器人如果没有收到入群事件，可由管理员发送 `/resume`。普通群升级超级群时会迁移订阅和待发收件人。

## 服务与固定配置

`alpha-telegram` 在 VPS 常驻，用 `getUpdates` 长轮询接收 `my_chat_member` 和命令，不需要新域名或 HTTPS 回调。不能同时运行另一份轮询进程或设置 Telegram webhook。发现已有 webhook 时不会自动清除。

固定 Token 写在服务器配置代码 `/var/lib/alpha-agent/telegram-config/telegram.config.mjs`：

```js
export default {
  token: "这里填写机器人 Token",
  relaySecret: "与网站 CRON_SECRET 相同的值",
};
```

配置文件通过只读目录挂载，代码直接加载这些常量。它与公开源码和构建产物分开，自动部署不会覆盖此文件。修改后运行 `docker compose restart telegram`。也支持 `TELEGRAM_CONFIG_PATH` 指定配置位置。

网站通过 `MARKET_DATA_BASE_URL/telegram` 把图片持久化入队，使用 `CRON_SECRET` 对时间戳和请求正文签名。可用 `TELEGRAM_RELAY_URL`、`TELEGRAM_RELAY_SECRET` 覆盖默认值。`TELEGRAM_ENABLED=false` 可关闭同步。机器人 Token 不经过网站、HTTP 中转请求或日志。

## 持久化、重试与部署

订阅和接收游标存于 `/var/lib/alpha-agent/telegram/state.json`，每条信号及其各群投递进度存于 `jobs/`。两个平台独立执行；Telegram 入队失败会明确报错，Discord 仍会尝试发送。入队后的单群失败由后台重试，不需要重跑每日任务。

每群至少间隔 3.1 秒，机器人全局最多约 22 次发送/秒；遇到 429 按 `retry_after` 冷却。临时错误退避重试；403 暂停无权限群，恢复权限后可 `/resume`；其他不可恢复参数错误记为失败。超过 24 小时的待发信号失效，避免服务恢复后补发过时交易信号。

账本与 GEX 按卡片业务内容生成稳定 ID；重复入队不会重发已完成群，也不会给后来加入的群补发历史卡片。TradingView 新版消息携带 `barTime` 时按同一 K 线信号去重；旧版没有时间标识时保留每个请求，避免误吞同价位的下一笔交易。API 超时发生在 Telegram 已接收、服务尚未收到响应的瞬间，重试仍可能重复；Telegram 没有客户端幂等发送键，因此不宣称绝对恰好一次。

每次推送代码会自动构建、部署两个 worker，持久化目录与配置目录不随代码清理。检查方法：

```sh
npm run telegram:worker:bundle
npm test
# VPS
docker logs --tail 30 alpha-telegram
curl -fsS http://127.0.0.1:8787/telegram/health
# 网站到 VPS 的签名链路检查（只读，不发送消息）
curl -fsS https://alpha-agent-eight.vercel.app/api/telegram/status
```

网站状态接口仅公开连接状态、机器人用户名和订阅数量，不公开群名、群 ID 或消息内容。

Telegram 规则：[更新事件](https://core.telegram.org/bots/api#update)、[发送限制](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)。
