# 日内共振信号：TV → VPS 存档 → DC / TG

离线验证、模拟成交和后续 TV 静默接入的工程设计见 [离线研究方案](./intraday-offline-plan.md)。该方案尚待实现；现有信号参考价不能直接作为成交成绩。

## 范围

脚本：`docs/tradingview-intraday-resonance.pine`，协议 `intraday-v1`，策略 `resonance-long`，首版 `1.0.0`。

采用用户 2026-09-28 最新的共振公式，替代早先三指标规格的买入/卖出触发条件。MACD、额外 3% 回调条件不再作为买入门槛。基础股票过滤保留为可关闭的输入。

| 规则 | 实现 |
| --- | --- |
| 唯一扳机 | 27 根价格位置 → 三层 `ta.rma(...,3)`；TREND 上穿 POWERLINE 且 TREND < 30 |
| 优质买点 | 扳机 + 当前及前 2 根中至少一次操盘顾问/长短顾问 |
| 能量共振 | 扳机 + 当前及前 2 根中至少一次资线上穿长庄线，资线 > 主线，长庄线 < 35 |
| 两种共振同时成立 | 优质买点优先，原始快照中保留两个布尔值 |
| 买点冷却 | `FILTER(X,4)`：发出后屏蔽后续 4 根，第 5 根才可再次触发；被屏蔽的触发不延长冷却 |
| 减仓 | 用户 COND_SELL 公式，FILTER 4 根；同一模型交易首次减仓发 partial，不擅自假设卖出比例 |
| 逃顶 | 用户 TOP_ZONE 公式，FILTER 5 根；有模型交易时发 exit |
| 止损 | 入场时锁定最近 8 根低点（可配置），不能下移；后续 K 线触及时发 stop，优先于其他退出 |
| 时段 | 默认美东 04:00–09:30，周一至周五；默认时段结束关闭模型交易 |
| 斐波那契 | 当前最新 120 根的高低及 38.2/50/61.8 水平；仅画线，不写入历史买卖逻辑 |

买点、减仓、逃顶以 **1 分钟收盘确认**。实时止损逐次报价检查，`varip` 防止同一根反复发送。历史止损只有 OHLC，按 `min(open, lockedStop)` 作为保守参考，不能据此宣称历史与逐笔实盘一致。停牌或没有新报价时脚本无法即时告警。

严格采用用户指定的 TV `ta.rma` 初始化方式。其他软件的 SMA(N,1) 递推系数相同，不代表初始化、历史长度、复权、盘前数据源也相同；跨平台逐根相等需要导出相同 OHLCV 验证，不能只靠公式注释认定。

## 股票池和过滤

- 在 TV 维护广泛的美股列表，按套餐容量拆分；不限制为 SP500。
- 默认过滤：$1–20、相对上一完整常规交易日收盘涨幅 ≥20%、当日累计成交量 / 前 50 个完整交易日日均量 ≥5、Float <2000万股。
- 缺少 Float、前收或日均量时不放行。日均量用 TV 日线口径；不是“同一盘前时刻”的相对成交量。
- `request.security` 仅使用上一日完成值 `[1]`，结合 `lookahead_on`；不读取当日尚未结束的日线最终值。
- 默认不加新闻硬过滤，快照和消息写明“新闻未核验”。本版不声称实现了全市场排名前8、实时新闻验证或实际账户止损限额。
- 大池只是覆盖范围；名单以外股票不会触发。IPO/改名/退市需要维护。

### 可直接导入的 1000 只监控名单

文件：[tradingview-intraday-1000.txt](./tradingview-intraday-1000.txt)。2026-09-28 生成，共 **1000 个不重复股票代码**：NASDAQ 724、NYSE 215、NYSE American（TV 前缀 `AMEX`）61。按股票代码字母排序，文件只有一行逗号分隔的 `交易所:代码`，不含标题或说明文字。

来源与筛选口径：

1. 上市目录使用 Nasdaq 官方 [nasdaqlisted.txt](https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt) 和 [otherlisted.txt](https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt)，两份源文件的生成标记均为 `0928202603:03`。仅取这三个交易所的普通股/普通股份及存托股；排除测试证券、ETF、名称中标明的优先股、权证、配股权、单位、债券、基金和 acquisition 公司。Nasdaq Financial Status 必须为 N，代码只取 1–5 位英文字母。
2. 行情来自 Alpaca **SIP 历史日线**，请求范围 2026-08-27 至 2026-09-25，按拆股调整。每只取最近最多 20 根日线，要求至少 15 根且最新日线日期为 **2026-09-25**；不是实时盘前数据。
3. 最新日线收盘价 $1–20，窗口内日成交量中位数 ≥10 万股，日成交额估算值（`volume × VWAP`）中位数 ≥25 万美元。合格候选共 1543 只。
4. 按窗口内日内振幅 `100 × (high − low) / close` 的中位数从高到低取前 1000，只用于提高动量监控覆盖；并列时按成交额中位数、股票代码排序。选中股票实际都有 18–20 根日线。

**这是一份低价、成交活跃的静态监控池，不是已经通过所有买入条件的名单，也不是完整的低流通盘/小市值筛选。** 当前批量数据未核验市值和 Float；TV 脚本仍在触发时检查 Float、涨幅、成交量、时段及共振。上述历史振幅排序没有经过盈利优化或胜率验证。IPO、改名、退市、价格变化会使名单过时，本文件不会自动刷新。

导入：TV 右侧列表名称菜单 → **Upload list… / 上传列表** → 选择此 TXT。建议使用单独的空列表；[TV 官方上限为每份列表 1000 个标的](https://www.tradingview.com/support/solutions/43000611193-how-many-symbols-can-i-add-to-the-watchlist/)，[导入要求交易所前缀、逗号分隔的 TXT](https://www.tradingview.com/support/solutions/43000487233-how-to-import-or-export-a-watchlist/)。代码和前缀已对照上市目录检查；尚未在用户的 TV 账号实际导入验证。

导入名单不等于创建或启用告警；仍需按下文完成脚本、列表告警、Extended 和服务器部署配置。名单 SHA-256：`230ad84d6dc0750128008f5914b181bcfd0bf6a1c96b2d7c74da62e8259e8c7f`。

图上的灰色原始买点（需打开“显示未通过股票过滤的原始买点”）仅用于校验数学公式；不是 webhook 交易信号。正常图标与告警经过股票过滤和时段检查。模型已有交易时的新共振发 watch，不重复开模型仓。无模型持仓时，原始减仓/逃顶可在数据窗口检查，不生成虚构的关联退出。

## 记录范围和持久性

流程：TV → HTTPS `/api/tv/intraday` → 加密 OIDC 服务身份 → VPS 常驻进程 → `fsync` 写盘 → 回应 TV → 后台转发。

VPS 主机保存位置：

```text
/var/lib/alpha-agent/telegram/intraday/YYYY-MM-DD/<signal-id>.json
/var/lib/alpha-agent/telegram/intraday/YYYY-MM-DD/receipts.ndjson
```

日期按 K 线的美东交易日划分。每条记录保留：

- 股票和交易所、周期、策略版本、完整参数签名、参数快照；
- 事件类型、共振种类、触发价、锁定止损、原始入场信号时间；
- 三条 WR 线、TREND、POWERLINE、TREND1、量比、涨幅、Float 和共振布尔值；
- 原始触发时间、服务器接收时间（UTC 时间戳，美东格式展示）；
- 稳定信号 ID、交易关联 ID、时效判定、路由配置版本；
- 接收当时是否已观测到对应入场，避免将 TV 历史模型状态误记为已接收的交易；
- 各目标发送状态、尝试次数、下次重试时间和错误码；TG 最终投递结果由原有队列提供。

**200 表示已经在 VPS 写入成功，不表示 DC/TG 已收到。** VPS 不可用返回 503，不在 Vercel 临时磁盘假装持久化。档案故障只关闭日内接收，不阻断原有 Telegram 功能。

首次有效信号快照固定；相同 ID 重复到达不重发，修改价格/指标的冲突包不覆盖原快照，逐次来包保存在 receipts。重复来包不会刷新信号有效期。

延迟超过 120 秒、提前超过 30 秒的有效信号也存档，但不转发；关闭推送、无目标、投递失败仍留档。待发送信号超过触发后 180 秒停止补发，TG 队列同样限制。阈值统一在 `app.config.ts`。

存档范围是 **此新协议通过鉴权且成功接收到的信号**。TV 未触发、网络完全未送达、非法 JSON/格式或鉴权失败的请求不会成为交易档案。原有 2H/4H 接口保持原规则与存储方式，不会自动改为这套日内档案。

部分平台在超时后实际已发送但未返回结果，重试有小概率产生重复消息；记录 `delivery_unconfirmed`，不承诺外部渠道 exactly-once。DC 成功取得回执后不会因为 TG 失败而重发，反之亦然。

目录在现有 Docker 主机卷中，重启或重新部署不会清空。应纳入 VPS 的异地备份；本功能不等于完成了异地备份。

## 配置与启用

1. 在现有 VPS 私有文件 `/var/lib/alpha-agent/telegram-config/telegram.config.mjs` 的默认配置对象中增加 `intradayWebhookSecret`，值为新生成的 64 位十六进制随机串。**不能复用 Bot Token、CRON_SECRET 或 relaySecret**，不能提交仓库。
2. 部署代码并重启 Telegram worker；它新增只读挂载 `/var/lib/alpha-agent/desk:/desk:ro` 用于获取网站保存的推送配置。现有端口、定时任务频率不变。
3. `/telegram/health` 中 `intradayConfigured: true` 表示档案可用且配置了专用密钥。它不等于端到端 TV 实盘验证通过。
4. 网站 `/push` 新增“日内共振信号”，**默认关闭推送**；保留常规 DC 目标与 TG 订阅群的配置，研究阶段只存档。以后明确开启后可独立更改或关闭。首版使用短文本，避免出图拖慢日内消息。
5. 将 Pine 放入 TV，使用标准 **1 分钟 + Extended**；创建列表告警，条件选此指标的 **Any alert() function call**。列表告警也要设 Extended，启用 TV 双重认证及所需行情订阅。
6. Webhook URL：`https://alpha-agent-eight.vercel.app/api/tv/intraday?key=<专用密钥>`。该 URL 含接收凭据，不要截图分享或贴入仓库；限制访问日志权限，泄漏后轮换。正文由脚本自动产生 JSON，无需手填。
7. 代码或输入参数修改后重建 TV 告警，否则服务器收到的仍是旧脚本/旧参数。脚本初始化前的历史图上买点不会自动补发。

本地联调额外使用 `.env.local` 的 `TV_INTRADAY_WEBHOOK_SECRET` 和已有 `TELEGRAM_RELAY_SECRET`；生产仍在 VPS 校验专用密钥，不增加 Vercel 业务环境变量。测试使用临时目录和模拟发送，不向真实频道发消息。

## 复盘导出

使用现有管理员 `CRON_SECRET` 作为 Bearer 身份（不要放 URL），访问：

```text
GET /api/tv/intraday?date=2026-09-28
GET /api/tv/intraday?date=2026-09-28&format=csv
Authorization: Bearer <管理员密钥>
```

JSON 包含完整结构，CSV 每行一个唯一信号，含参数、指标和投递结果 JSON 列。逐次重复/冲突的原始来包另在 VPS `receipts.ndjson`，不混入唯一信号数量。

交易以策略版本、参数、交易所股票、周期及原始入场时间关联。退出先于入场送达、TV 重新创建告警、历史模型状态延续到实时时可能出现缺失入场；保留明确的入场参考，但不要将其当作服务器曾观测到的真实成交。

接收档案只保留信号事实，**没有券商成交回报，不计算真实盈亏**。新增 `/intraday` 离线研究页和 `intraday:lab reconcile` 可只读导入这些原始收件记录，用历史行情模拟执行；模拟与真实成交分开，原始信号不会因后续研究改写。具体口径见 [离线研究方案及首次结果](./intraday-offline-plan.md)。

## 官方边界

- [TV Webhook：3秒超时及投递状态](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)
- [Pine 告警：实时触发、脚本快照和频率](https://www.tradingview.com/pine-script-docs/concepts/alerts/)
- [实时回滚与 varip](https://www.tradingview.com/pine-script-docs/language/execution-model/)
