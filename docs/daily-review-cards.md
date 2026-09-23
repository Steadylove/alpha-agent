# 每日复盘双图

每日收盘链在 GEX、账本、每日复盘和宏观补采完成后，先发原 GEX 简报，再生成并发送 Tomorrow Map、Options Market Map。使用现有北京时间周二至周六 08:30 的任务，不新增定时器。美股假期由交易日历与发送回执控制；不会把旧图标成新交易日。

## 数据与样式

- Tomorrow Map 使用已归档的每日复盘、11 期历史、入场评分和账户快照。
- Options Market Map 使用截至当日的 SPX 45 根日线、四标的 GEX 快照，以及采集同一条期权链时存下的逐行权价 Gamma 分布。
- `fetch-gex-snapshot.py` 将 profile 保存到 `.cache/gex/profiles/YYYY-MM-DD/{symbol}.json`；主任务同步到 `market/snapshots/gex-profiles/`。日期、报价时间、口径版本、DTE、现价和净 GEX 必须与复盘相符。
- 前日口径不可核验则明确标注，不绘制虚假的墙位迁移。
- 图像使用既定深色、薄荷绿配色与罗盘，标题为固定矢量字样，Linux 不依赖 Georgia 字体安装；中文使用 `fonts-noto-cjk`。页脚统一为“仅供信息参考，不构成投资建议”。

## 路由与发送

直接读取网页配置的 `routes.gex`，不维护另一份频道列表。开关、Discord 自定义 Webhook、镜像、Telegram 目标均跟随 GEX 简报。正式 PNG/SVG 存于 `market/snapshots/review-cards/YYYY-MM-DD/`，同日补发复用已生成 PNG。

每张图片、每个 Discord 目标分别记回执，持久目录为 `desk/review-card-delivery/`；Telegram 使用固定事件键入队。重跑跳过成功项，明确拒绝的发送可重试；Discord 网络超时、缺少回执或发送中进程退出时保留待核验状态，避免盲目重发。Telegram 入队完成后仍由现有 relay 负责最终送达。Webhook 密钥不写入回执与日志。

## 部署与运维

`npm run review:cards:bundle` 生成独立 worker、collector 和 Logo，部署 workflow 一并上传。`install-review-cards.sh` 安装到 `market-http/`，避免每日仓库 reset 导致运行版本丢失；不会改动任务频率。原 `install-daily-quant.sh` 安装新的主任务调用链及 CJK 字体。

服务器先预览：

```sh
bash /var/lib/alpha-agent/bin/alpha-review-cards.sh --dry-run
```

确认后发送/补发：

```sh
bash /var/lib/alpha-agent/bin/alpha-review-cards.sh
```

两次调用均通过同一把 `review-cards.lock` 防止并发。预览写入单独的 `review-cards-preview` 目录、不发消息、不修改正式回执。健康检查或出图失败停止双图推送，并将失败交给每日任务；原 GEX/账本仍独立运行。

Telegram 凭据沿用服务器现有的 `telegram-config/telegram.config.mjs` 中 `relaySecret`；不复制到仓库。单独调用 TypeScript 脚本时应自行持有相同锁，并配置本地行情、路由、状态目录和 relay 环境。
