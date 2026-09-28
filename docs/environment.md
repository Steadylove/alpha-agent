# 环境变量与配置入口

更新：2026-09-28。公开默认值集中在 [`app.config.ts`](../app.config.ts)。网站生产密钥保存在 VPS 私有文件，按请求通过 Vercel 服务身份读取；无需在 Vercel 控制台配置业务变量。变量检查器与完整元数据合并在 [`scripts/env.ts`](../scripts/env.ts)。

## 1. 先按运行场景配置

| 场景 | 配置在哪里 | 主要配置 |
| --- | --- | --- |
| 本地网站与 Node CLI | 根目录 `.env`，本机覆盖用 `.env.local` | 行情 URL / 目录、需要的 API 凭据、推送默认值 |
| Vercel 网站 | 公开项：`app.config.ts`；密钥：VPS `/var/lib/alpha-agent/telegram-config/web-secrets.json` | 请求时认证读取，仅生产身份可用；Vercel 仅保留平台自带变量 |
| VPS 日更、宏观补采、Catalyst、日报图 | `/var/lib/alpha-agent/daily-quant.env` | Alpaca、独立分析密钥、可选来源；数据路径由包装脚本设置 |
| VPS 期权流 worker | `/var/lib/alpha-agent/option-flow.env` | Discord Bot、来源频道、过滤开关、轮询间隔 |
| VPS desk / book | `/var/lib/alpha-agent/market-http/docker-compose.yml` 与同目录 `.env` | Compose 注入文件路径；可从 `.env` 读取 `DESK_STORE_SECRET` |
| VPS Telegram | `/var/lib/alpha-agent/telegram-config/telegram.config.mjs`，挂载到容器 `/config/telegram.config.mjs` | `token`、`relaySecret`、`identityPrivateKey`、`mode`、`webhookSecret` |
| GitHub Actions | Repository → Settings → Secrets and variables → Actions | `VPS_SSH_KEY`、手动补跑所需 API 凭据；它不是 Vercel 或 VPS 配置的自动镜像 |
| Theta 本地研究 | `.env.local` 的 `THETADATA_API_KEY`，或进程环境 | 与生产每日 GEX 采集分开 |

每个场景只配置实际需要的项。文件路径、端口、重试次数和研究参数已有默认值，不需要把附录全部复制进环境文件。

### 文件保持精简

- 公开配置：`app.config.ts`，跟随 Git 部署。
- 本地私有配置：`.env` / `.env.local`；只保留一个 [`.env.example`](../.env.example) 模板。
- 网站私有配置：VPS `web-secrets.json`，与已有 Telegram 私有配置目录共同挂载，不增加服务或端口。
- 检查与加载：`scripts/env.ts` + `scripts/load-env.ts`。不再单独维护 JSON 字典、三个检查辅助文件和三份服务模板。

生产已有 `daily-quant.env` / `option-flow.env` 保留服务隔离，避免网站读到行情采集或研究密钥。它们不是需要提交的新模板。

### 网站怎样取得密钥

1. 请求进入网站服务端后，使用 Vercel 平台自动提供的短期 OIDC 身份。
2. VPS 校验签名、有效期、团队、项目和 **production** 环境；本地普通签名、其他项目和 Preview 都不能取生产密钥。
3. 请求凭据和响应均加密。响应密钥只放在加密身份内，不通过普通 HTTP 头或正文发送。
4. 网站仅在服务端内存缓存 5 分钟；到期重新读取文件。VPS 文件更新后，无需重启服务；最多 5 分钟生效。新加载失败会阻止相关请求执行，不回落到旧 Vercel 凭据。
5. TradingView 保留立即接收告警的行为，配置读取放在后台出图任务中。

Vercel OIDC 在请求期间可用，因此此加载放在页面 / API 入口，不在构建或模块初始化时调用。使用私有配置的服务端页面显式设置 `dynamic = "force-dynamic"`，避免构建时预渲染触发读取。参考 [Vercel OIDC](https://vercel.com/docs/oidc/reference)。仓库白名单只允许网站实际用到的密钥；不会把 VPS 全部环境变量传给网站。

私有 JSON 结构（示意值，勿直接覆盖生产文件）：

```json
{
  "CRON_SECRET": "实际鉴权密钥",
  "DISCORD_WEBHOOK_URL": "实际通用 webhook",
  "DISCORD_MIRROR_GEX_WEBHOOK_URL": "实际 GEX 镜像 webhook"
}
```

其他可选字段见 `app.config.ts` 的 `WEB_SECRET_KEYS`；必填 `CRON_SECRET`，未配置可选密钥时对应来源保持不可用。文件由 root 管理、权限 600，不放进公开行情目录，不提交 Git，不打入 Vercel 包。

## 2. 本地加载顺序

原先使用 dotenv 的 Node CLI 已统一通过 `scripts/load-env.ts` 加载，**现有进程环境始终优先，包括显式空字符串**。这保证 VPS / GitHub / Docker 注入的参数不会被仓库文件覆盖。常驻 book / option-flow / Telegram worker 继续直接使用容器注入的配置；不额外读取本机环境文件。

默认文件优先级与 Next 一致：

1. 进程环境变量。
2. `.env.<NODE_ENV>.local`。
3. `.env.local`（`NODE_ENV=test` 时跳过）。
4. `.env.<NODE_ENV>`。
5. `.env`。

CLI 未提供 `NODE_ENV` 时使用 `development` 文件组。设置 `DOTENV_CONFIG_PATH` 时只读取该文件，不叠加默认文件；它仍不能覆盖进程注入值。此显式文件选项只供 CLI，不改变 Next 的加载规则。

环境文件请填写具体值，不使用 shell 命令或跨变量插值：Next、dotenv 与 Bash 对这些语法的处理不相同。`.env.vercel.local` 是以前从 CLI 导出的副本，不属于默认加载链；本次已在本机私有备份目录归档，不能当作线上实时配置。

GEX 与期权日结脚本原先使用 `override: true`，本次改为统一规则，避免文件中的旧 webhook 或密钥覆盖部署注入值。

## 3. 数据与鉴权

- `MARKET_DATA_BASE_URL` 非空时，行情读取优先使用远程服务；否则读 `MARKET_DATA_DIR` 对应目录，未设目录时沿用本地 `data/` 布局。Vercel 未指定 URL 时使用 `app.config.ts` 的 VPS 地址。
- 显式设置 `SIGNAL_POOL_PATH`、`LIVE_BOOKS_PATH`、`PUSH_ROUTES_PATH` 等，会把对应存储切为本地文件。不要在 Vercel 填 VPS 上的绝对路径：它们不是同一台机器的磁盘。
- 收盘采集、复盘生成和图片任务需要本地已完成的数据。补采 / Catalyst / 图片包装脚本会清空远程 URL 并取消 `VERCEL`，这些设置保留原样。
- `ALPACA_API_KEY` / `ALPACA_API_SECRET` 是推荐名称。SDK 读取层兼容 `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`，但 VPS 主日更校验需要推荐名称。
- `ALPACA_FEED` 不填写时自动选择；需要 SIP 长历史时填 `sip`。不要填写空字符串。`ALPACA_MAX_INFLIGHT` 必须为正整数。
- `CRON_SECRET` 用于受保护任务接口。desk / book 及客户端优先使用 `DESK_STORE_SECRET`，部分客户端可回落 `CRON_SECRET`；启用时要在对应服务和调用方同步，不能只改一端。
- Telegram 在 Vercel 上使用服务身份；本地和日更图片使用 `TELEGRAM_RELAY_SECRET`。Telegram 服务配置文件中的 `token` / `relaySecret` 优先于其环境变量后备值。

## 4. 推送配置收束到网页

**频道、推送类型开关、Telegram 接收群、期权大单金额门槛，以 `/push` 保存的 `push-routes.json` 为日常管理入口。**

环境变量中的 webhook 保留为默认值、首次填充与兼容来源，不作为覆盖已保存路由的第二套配置。

- 通用 / 选股默认频道：`DISCORD_WEBHOOK_URL`。
- 信号 / 账本 / GEX 默认频道：`DISCORD_SIGNAL_WEBHOOK_URL`，缺省回落通用地址。
- 四个 `DISCORD_MIRROR_*_WEBHOOK_URL` 是各类镜像默认地址。
- 常驻期权流 worker 每次读取网页保存的金额门槛，初始默认 **500,000 美元**。它会覆盖 `OPTION_FLOW_MIN_PREMIUM_USD`；后者仅保留给手动解析等调用作为后备值。
- `DISCORD_OPTION_CHANNEL_ID` 是读取来源；`DISCORD_SIGNAL_CHANNEL_ID` 是名单 / 热力图无 webhook 时的 Bot 发送后备频道，两者含义不同。
- `GEX_TEST=1` 只加测试标记，仍会真实发送；配置检查命令不会调用这些脚本或发送消息。

## 5. AI 与可选来源

| 用途 | 密钥优先级 |
| --- | --- |
| 每日复盘分析 | `DEEPSEEK_REVIEW_API_KEY` → `DEEPSEEK_API_KEY` |
| Catalyst 事件分析 | `DEEPSEEK_CATALYST_API_KEY` → review → 通用 |
| Context 个股分析 | `DEEPSEEK_CONTEXT_API_KEY` → catalyst → review → 通用 |
| 旧选股 AI | 通用密钥；`SCREENER_SKIP_AI` 默认 true，VPS 主任务也强制 true |

模型变量按相应模块向 review 模型回落，未配置时使用模块默认值。`FMP_API_KEY` 仍用于个股资料与财报日历；`SEC_USER_AGENT` 是 SEC 采集身份。`FRED_API_KEY` 和 `FINNHUB_API_KEY` 当前已无消费者，不需要配置。免费 HTTP 行情或宏观源没有 API Key 项，不代表未接入。

## 6. 本次迁移状态（2026-09-28）

| 位置 | 状态 |
| --- | --- |
| 仓库 | 公开默认值集中到 `app.config.ts`；检查器合并为 `scripts/env.ts`，保留单一 `.env.example` |
| VPS 私有配置 | 已迁入 8 项现有网站凭据：CRON、FMP、DeepSeek、通用 Discord webhook、4 个镜像 webhook；文件权限 600 |
| VPS 配置端点 | 已更新现有服务；健康检查通过，匿名请求返回 401。旧 Telegram 接口和持久化队列保留 |
| Vercel | 12 项旧业务变量已全部移除；Production / Preview / Development 的手工变量清单为空。最终生产部署使用 VPS 配置 |
| VPS 其他任务 | `daily-quant.env`、`option-flow.env` 及调度未改；没有把采集凭据额外传给网站 |
| 本地 | `.env` / `.env.local` 保留私有配置；废弃项和重复项已备份清理 |

### 迁移顺序

已完成：私有文件落盘与服务备份 → 生产验证部署确认 OIDC 取密钥成功 → 删除 12 项 Vercel 业务变量 → 无业务变量的新部署重新构建并验证。最终部署：`dpl_FxV6YapsAQgYG2ejtBL5AkGgstRJ`，已切换到正式域名 [alpha-agent-eight.vercel.app](https://alpha-agent-eight.vercel.app)，普通公网请求复核通过。

Vercel 12 项旧变量中，`DATABASE_URL`、`FRED_API_KEY`、`FINNHUB_API_KEY` 已无消费者；`SCREENER_SKIP_AI` 在公开配置中默认开启；其余 8 项已迁入 VPS。平台的 `VERCEL_*`、`NODE_ENV` 等自动变量继续由平台提供，不属于需要填写的业务配置。

VPS 服务备份：`/var/lib/alpha-agent/private-backups/web-config-20260928-152656/`。旧 Vercel 业务变量保留在本机 `.cache/private-env-backups/vercel-business-before-migration-20260928.env`（权限 600）；已清除迁移临时密钥副本与导出的平台身份令牌。备份目录由 Git 忽略。没有发送测试消息。

### 验证

- 127 个测试文件、1,184 项测试通过，覆盖身份隔离、双向加密、缓存刷新、失败阻断和原有推送逻辑。
- 类型检查、本次修改文件的 ESLint、完整生产构建和配置服务打包通过；额外使用 `VERCEL=1 VERCEL_ENV=production` 构建，确认预渲染不访问私有配置。
- `.vercelignore` 排除本地环境文件、私有备份与行情数据；上传预检 417 个文件、约 4.3 MB，私有文件为 0；Next 函数跟踪清单中私有文件为 0。
- 无业务变量的最终生产部署：每日复盘、机会、异常期权流均返回 200；账户接口读取到两套账本；Telegram 状态为 `ok: true`；未带密钥的任务请求在配置加载后返回 401。没有放宽 OIDC 生产身份限制。

## 7. 自检命令

```bash
npm run env:check
npm run env:check -- --profile=daily --strict
npm run env:check -- --profile=flow --file=/path/to/option-flow.env --strict
npm run env:check -- --profile=theta --strict
npm run env:check -- --list
```

- 只读取配置，输出名称、来源、是否为空、重复与退役项；不输出值、长度或摘要，也不连接外部服务。
- `--strict` 遇到当前场景缺项、无效数值、退役项或未登记键时返回非零状态。默认 `all` 不把每个可选模块的密钥都当成必填。
- `--file` 用于检查单个外部服务文件，已有进程环境仍优先；在干净 shell 中检查可避免继承其他场景的变量。
- `--json` 用于机器读取，仍不包含变量值。
- 检查器不执行 Telegram 私有 JavaScript 配置、不读取网页路由文件，也不验证上游订阅权限。环境配置通过后，仍以对应服务健康检查与数据更新时间判断运行状态。

## 8. 完整变量字典

完整登记与检查规则位于 `scripts/env.ts`。以下是维护参考；公开默认值在 `app.config.ts` 修改，不需要在 Vercel 重复填写。不要把表内所有项都设成空字符串。


### 数据源

| 变量 | 默认 / 必填范围 | 用途 |
| --- | --- | --- |
| `ALPACA_API_KEY` | 必填：daily | Alpaca Key ID；与 Secret 成对配置 |
| `ALPACA_API_SECRET` | 必填：daily | Alpaca Secret；与 Key ID 成对配置 |
| `ALPACA_FEED` | 按场景可选 | 行情权限；不设置时自动选择 sip / iex，VPS 日更使用 sip |
| `ALPACA_MAX_INFLIGHT` | 3 | Alpaca 同时在途请求上限 |
| `APCA_API_KEY_ID` | 按场景可选 | 兼容别名，优先使用 ALPACA_API_KEY |
| `APCA_API_SECRET_KEY` | 按场景可选 | 兼容别名，优先使用 ALPACA_API_SECRET |
| `FMP_API_KEY` | 按场景可选 | 可选：个股资料及财报日历 |
| `SEC_USER_AGENT` | 按场景可选 | SEC 请求身份，组织名及联系邮箱；事件披露采集需要显式填写 |

### 文件与鉴权

| 变量 | 默认 / 必填范围 | 用途 |
| --- | --- | --- |
| `MARKET_DATA_BASE_URL` | 按场景可选 | 远程行情服务；非空时行情读取优先使用远程服务 |
| `MARKET_DATA_DIR` | 按场景可选 | 本地行情根目录，布局为 1d / 4h / 2h / 1h / rps |
| `CRON_SECRET` | 按场景可选 | 受保护任务接口密钥；兼作部分 desk 客户端鉴权的后备值 |
| `DESK_STORE_SECRET` | 按场景可选 | desk 与账本服务的共享写入密钥，客户端和服务端必须一致 |
| `SIGNAL_JOURNAL_DIR` | 按场景可选 | 本地信号档案目录；设置后对应档案读写改为本地 |
| `SIGNAL_POOL_PATH` | 按场景可选 | 本地股票池 JSON 路径 |
| `BOOK_EPOCH_PATH` | 按场景可选 | 本地账本版本 JSON 路径 |
| `LIVE_BOOKS_PATH` | 按场景可选 | 本地 2H / 4H 模型账户 JSON 路径 |
| `LIVE_BOOK_PATH` | 按场景可选 | 本地单一连续账本 JSON 路径 |
| `FUND_BOOK_PATH` | 按场景可选 | 本地资金账本 JSON 路径 |
| `LOOKBACK_SNAPSHOTS_PATH` | 按场景可选 | 本地回看快照 JSON 路径 |
| `PUSH_ROUTES_PATH` | 按场景可选 | 本地推送路由 JSON 路径 |
| `OPTION_FLOW_PATH` | 按场景可选 | 本地期权流记录 JSON 路径 |
| `GEX_HISTORY_DIR` | 按场景可选 | 历史 GEX 输入目录 |

### 推送与期权流

| 变量 | 默认 / 必填范围 | 用途 |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | 按场景可选 | 选股频道和通用默认 webhook |
| `DISCORD_SIGNAL_WEBHOOK_URL` | 按场景可选 | 信号 / 账本 / GEX 默认 webhook，缺省回落通用地址 |
| `DISCORD_MIRROR_4H_WEBHOOK_URL` | 按场景可选 | 4H 镜像默认 webhook |
| `DISCORD_MIRROR_2H_WEBHOOK_URL` | 按场景可选 | 2H 镜像默认 webhook |
| `DISCORD_MIRROR_BOOK_WEBHOOK_URL` | 按场景可选 | 账本镜像默认 webhook |
| `DISCORD_MIRROR_GEX_WEBHOOK_URL` | 按场景可选 | GEX 镜像默认 webhook |
| `DISCORD_BOT_TOKEN` | 必填：flow | 期权流源频道读取，以及无 webhook 时的 Bot 发送 |
| `DISCORD_OPTION_CHANNEL_ID` | 按场景可选 | 期权流来源频道；有现有业务默认值 |
| `DISCORD_SIGNAL_CHANNEL_ID` | 按场景可选 | 名单 / 热力图的 Bot 发送后备频道 |
| `OPTION_FLOW_MIN_PREMIUM_USD` | 500000 | 手动解析工具的后备金额门槛；常驻 worker 使用 /push 保存的门槛覆盖它 |
| `OPTION_FLOW_DROP_ADS` | true | 过滤广告内容 |
| `OPTION_FLOW_DROP_PAID` | true | 过滤付费内容 |
| `OPTION_FLOW_POLL_MS` | 3000 | 期权流轮询间隔，单位毫秒 |
| `OPTION_FLOW_PUSH_URL` | 按场景可选 | 单笔期权流交给网站推送的接口地址 |
| `TELEGRAM_RELAY_URL` | 按场景可选 | Telegram 中继；缺省使用行情服务地址加 /telegram |
| `TELEGRAM_RELAY_SECRET` | 按场景可选 | 非 Vercel 客户端的中继签名密钥；需与 Telegram 服务一致 |
| `TELEGRAM_ENABLED` | true | 设置 false 禁用图片入队 |
| `BOOK_PUSH_URL` | 按场景可选 | 账本卡的远程接口，同时作为 GEX 远程推送的站点 origin |
| `GEX_PUSH_URL` | 按场景可选 | 覆盖 GEX 单卡远程接口 |
| `GEX_LOCAL` | 0 | 手动 GEX 工具使用本地渲染 |
| `GEX_TEST` | 0 | 手动推送加测试标记，仍会真实发送，不是 dry-run |

### 独立 AI 分析

| 变量 | 默认 / 必填范围 | 用途 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 按场景可选 | 通用后备密钥；旧选股分析也用它 |
| `DEEPSEEK_REVIEW_API_KEY` | 按场景可选 | 每日复盘专用密钥，优先于通用密钥 |
| `DEEPSEEK_REVIEW_MODEL` | 按场景可选 | 每日复盘模型，同时作为其他分析的后备模型 |
| `DEEPSEEK_CATALYST_API_KEY` | 按场景可选 | 事件分析密钥，依次回落 review / 通用 |
| `DEEPSEEK_CATALYST_MODEL` | 按场景可选 | 事件分析模型，回落 review 模型 |
| `DEEPSEEK_CONTEXT_API_KEY` | 按场景可选 | 个股 Context 分析密钥，依次回落 catalyst / review / 通用 |
| `DEEPSEEK_CONTEXT_MODEL` | 按场景可选 | Context 模型，依次回落 catalyst / review 模型 |
| `SCREENER_SKIP_AI` | true | 默认跳过旧选股 AI；VPS 主任务强制 true |

### 研究与维护

| 变量 | 默认 / 必填范围 | 用途 |
| --- | --- | --- |
| `THETADATA_API_KEY` | 必填：theta | Theta 本地期权研究 API Key，生产每日 GEX 不依赖它 |
| `THETA_PYTHON` | python3 | 创建 Theta 虚拟环境时选用的 Python 程序 |
| `PANEL_SNAPSHOT_URL` | 按场景可选 | 下载标普 / 纳指研究面板的快照 URL |
| `RPS_SCALE_FROM` | 2021-01-01 | 外生 RPS 标尺起始日 |
| `BACKFILL_CONCURRENCY` | 按场景可选 | 历史补采并发，因脚本不同默认 4 或 6 |
| `SMALLFUND_REFETCH` | 0 | 设为 1 强制重新获取已有 CSV；维护开关 |
| `GEX_OUTPUT_DIR` | 按场景可选 | Python GEX 采集器输出目录 |
| `ESBUILD_CLI` | 按场景可选 | 打包器可执行路径；不设置时使用 npx esbuild |
| `REVIEW_CARD_ASSET_DIR` | 按场景可选 | 复盘图 logo 等资源目录 |
| `REVIEW_CARD_STATE_DIR` | 按场景可选 | 复盘图投递去重状态目录 |
| `REVIEW_CARD_TELEGRAM_CONFIG` | 按场景可选 | 出图脚本读取 Telegram 中继签名密钥的配置文件 |
| `REVIEW_RETRY_SLEEP` | 45 | 日更派生数据步骤失败重试间隔，秒 |
| `MARKET_REFRESH_RETRY_SLEEP` | 45 | 行情刷新失败重试间隔，秒 |
| `ALPHA_ROOT` | /var/lib/alpha-agent | 补采 / Catalyst / 复盘图脚本的部署根目录；主日更仍使用固定生产根目录 |

### 服务及平台

| 变量 | 默认 / 必填范围 | 用途 |
| --- | --- | --- |
| `DESK_BIND` | 0.0.0.0 | desk HTTP 服务监听地址 |
| `DESK_DIR` | /data | desk HTTP 服务数据目录 |
| `PORT` | 按场景可选 | 当前服务监听端口，必须按服务分别设置 |
| `TELEGRAM_CONFIG_PATH` | /config/telegram.config.mjs | Telegram 服务挂载的私有配置文件，文件内字段优先于环境变量 |
| `TELEGRAM_BOT_TOKEN` | 按场景可选 | Telegram 服务无文件 token 时的后备值 |
| `TELEGRAM_DATA_DIR` | /data | Telegram 服务状态持久化目录 |
| `VERCEL` | 按场景可选 | Vercel 自动注入；手动设 1 也会启用远程数据及 OIDC 分支 |
| `NODE_ENV` | 按场景可选 | Next / CLI 的环境文件模式；未设置时 CLI 使用 development |
| `DOTENV_CONFIG_PATH` | 按场景可选 | CLI 指定单一环境文件；指定后不再叠加默认环境文件 |
| `NODE_OPTIONS` | 按场景可选 | Node 运行内存等参数，由任务 / 容器设置 |
| `TZ` | 按场景可选 | 进程时区，VPS 调度使用 Asia/Shanghai |
| `FONTCONFIG_FILE` | 按场景可选 | 出图模块自动设置的字体配置，通常不手动填写 |
| `MPLCONFIGDIR` | 按场景可选 | Python 绘图缓存目录，研究脚本自动设置 |
| `VPS_SSH_KEY` | 按场景可选 | GitHub Actions 的 SSH Secret，用于部署和手动补跑 |
