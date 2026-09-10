# Telegram 信号同步

项目产生的买卖信号、4H/2H 现金账本、GEX 与市场状态卡片同时发送到 Discord 和 Telegram。图片只渲染一次，两个平台使用同一份内容。Discord 中其他人手动发送的消息不在同步范围。

推送标题中，“现金账本1”对应 4H，“现金账本2”对应 2H。

## 群里怎么用

把机器人加入普通群或超级群，允许发送文字和图片。普通群自动订阅之后的新信号；开启话题的群等待管理员选择接收话题。无需登记群 ID，保留 Telegram 隐私模式即可。支持群话题，暂不支持独立频道和私聊广播。

### 发到指定话题

1. 打开 [将 @GexNoticeBot 加入群](https://t.me/GexNoticeBot?startgroup=signals)，选目标群。也可在群资料的“添加成员”里搜索机器人用户名。
2. 进入要接收推送的话题，例如“量化盘中推送”，由群管理员发送 `/resume@GexNoticeBot`。
3. 机器人在这个话题回复“已开启信号推送”后，之后的文字和图片都会发到这个话题。发送 `/status@GexNoticeBot` 可确认接收位置为“当前话题”。

每个群绑定一个接收位置，重启、权限变化与重新加群保留绑定。管理员在其他话题发送 `/resume` 会更换位置并取消旧位置尚未发出的信号；若要改回 General，请在 General 明确发送 `/resume`。加群链接自动发送的 `/start` 不会覆盖话题绑定。话题被删除或关闭导致发送失败时，不会自动改发到 General；重新开放话题或在新的目标话题发送 `/resume`，接收之后的新信号。

- `/status`：查看本群接收状态。
- `/pause`：暂停本群推送，仅群管理员可用。
- `/resume` 或 `/start`：开启接收并绑定当前话题，仅群管理员可用；General 中的 `/start` 仅提示选择话题。
- `/help`：使用说明。多个机器人同群时可加 `@机器人用户名`。

离群会取消该群待发信号；重新加入可以重新订阅。暂停后在目标话题恢复，只接收新信号。原先已在群里的机器人如果没有收到入群事件，可由管理员在目标位置发送 `/resume`。普通群升级超级群时会迁移订阅和待发收件人。

## 服务与固定配置

`alpha-telegram` 在 VPS 常驻。正式环境使用 Telegram webhook：`https://alpha-agent-eight.vercel.app/api/telegram/webhook`。网站将事件转交 VPS，在校验 Telegram 回调密钥并持久化处理后才确认成功；失败由 Telegram 重试。回调连接数设为 1，VPS 也串行处理更新，防止乱序或重复操作。启用 webhook 后，其他程序不能再使用这个机器人的 `getUpdates`。

也保留 `mode: "polling"` 的长轮询方式，供没有回调地址且没有其他接收进程的环境使用。

固定 Token 写在服务器配置代码 `/var/lib/alpha-agent/telegram-config/telegram.config.mjs`：

```js
export default {
  token: "这里填写机器人 Token",
  relaySecret: "独立生成的随机值，供本地 CLI 使用",
  identityPrivateKey: "与 relayPublicKey.ts 中公钥配对的 PKCS8 私钥",
  mode: "webhook",
  webhookSecret: "独立生成的 64 位十六进制随机值",
};
```

配置文件通过只读目录挂载，代码直接加载这些常量。它与公开源码和构建产物分开，自动部署不会覆盖此文件。修改后运行 `docker compose restart telegram`。也支持 `TELEGRAM_CONFIG_PATH` 指定配置位置。

网站通过 `MARKET_DATA_BASE_URL/telegram` 把图片持久化入队，使用 Vercel 自动签发的短期服务身份认证，无需另外设置网站密钥。VPS 校验签名、有效期、项目、团队与生产环境；预览部署不能向正式群发送消息。请求身份使用标准 JWE 加密，并绑定请求正文，身份令牌不会明文经过 HTTP 代理。私钥只保存在服务器配置中，对应公钥位于 `relayPublicKey.ts`。

本地 CLI 使用独立的 `TELEGRAM_RELAY_SECRET` 签名，必须与服务器 `relaySecret` 相同；不沿用 `.env.example` 中的示例 CRON 密钥。`TELEGRAM_RELAY_URL` 可覆盖服务地址，`TELEGRAM_ENABLED=false` 可关闭同步。机器人 Token 不经过网站、HTTP 中转请求或日志。

## 持久化、重试与部署

订阅和接收游标存于 `/var/lib/alpha-agent/telegram/state.json`，每条信号及其各群投递进度存于 `jobs/`。两个平台独立执行；Telegram 入队失败会明确报错，Discord 仍会尝试发送。入队后的单群失败由后台重试，不需要重跑每日任务。

每群至少间隔 3.1 秒，机器人全局最多约 22 次发送/秒；遇到 429 按 `retry_after` 冷却。临时错误退避重试；403 暂停无权限群，恢复权限后可 `/resume`；其他不可恢复参数错误记为失败。超过 24 小时的待发信号失效，避免服务恢复后补发过时交易信号。

账本与 GEX 按卡片业务内容生成稳定 ID；已有收件人的任务重复入队时保留投递进度，不会重发已完成群，也不会给后来加入的群补发历史卡片。若首次提交时没有订阅群或尚未绑定话题，收件人为 0 的记录不拦截重试；绑定后重新触发任务，会用本次提交的图片和当前接收话题安排投递。仅绑定话题不会自动补发历史。服务日志记录每次入队的收件人数与是否重复，便于区分未投递和已入队。

TradingView 新版消息携带 `barTime` 时按同一 K 线信号去重；旧版没有时间标识时保留每个请求，避免误吞同价位的下一笔交易。API 超时发生在 Telegram 已接收、服务尚未收到响应的瞬间，重试仍可能重复；Telegram 没有客户端幂等发送键，因此不宣称绝对恰好一次。

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

`setWebhook` 使用上述 HTTPS 地址、`secret_token: webhookSecret`、`max_connections: 1`、`allowed_updates: ["message", "my_chat_member"]`，保留待处理更新。机器人的 Token 和回调密钥都由部署者设置完成，拉群使用的人无需做服务器配置。

Telegram 规则：[更新事件](https://core.telegram.org/bots/api#update)、[发送限制](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)。
