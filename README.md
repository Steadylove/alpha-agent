# IBKR Desk

独立、个人自用的 IBKR 只读账户与行情工作台。与 alpha-agent 没有代码、数据、配置或部署依赖。只接 IBKR；无权限或无数据就显示缺失，不接其他行情供应商、不采集期权行情；已有期权持仓仅展示 IBKR 账户估值。

## 已实现的首版

- React + Vite 静态网页；Radix 下拉框和弹窗；Lightweight Charts K 线。
- Python FastAPI 单进程托管网页和 API；通过社区维护的 `ib_async` 连接 IB Gateway / TWS 的 Socket API。
- 工作台密码登录，HttpOnly 会话 Cookie，同源写请求校验，登录与改密共用限流。支持验证当前密码后修改工作台密码，修改后所有旧登录失效。工作台密码不是 IBKR 密码。
- 账户全景（`#account`）：当日/未实现/已实现盈亏，购买力、保证金、风险缓冲，多币种现金与资产，全部持仓估值，原始账户字段搜索。股票和期权等现有合约均展示，只有美元股票/ETF可打开K线；指定自选股票的报价；1m / 5m / 15m / 1h / 1d 历史 K 线、指定结束日期与常规/延长交易时段。
- 顶部与侧栏可切换独立订单记录视图（`#orders`），支持刷新与浏览器前进/后退。委托记录显示本工作台最近 100 条订单；另展示已归档的最近 200 笔成交与佣金，支持 Gateway 同步、Flex 在线同步和 XML / CSV 历史成交导入。
- SQLite 行情缓存、订单记录与券商回报。断网缓存明确标记过期，缺失行情不会补造。
- 所有账户固定只读：无买卖、改单、撤单、行权、提现或转账入口。旧版模拟盘开关已移除，不能通过配置重新启用。
- 后端仅允许登录、退出、修改工作台密码、建立只读连接，以及本地成交报表配置和导入使用写方法，其他 `/api/*` 写请求统一返回 403；券商适配器没有提交或撤单方法。

## 本地启动

需要 Node.js 22、uv、Python 3.12。IB Gateway 可以稍后接入；未接入时网页正常显示空状态。

```sh
cp .env.example .env
# 编辑 .env，设置至少 6 字符的 DESK_PASSWORD
uv sync --python 3.12
npm ci
npm run build
uv run uvicorn desk.app:app --host 127.0.0.1 --port 8018
```

打开 http://127.0.0.1:8018 。本地调试时后端可改用 `uv run uvicorn desk.app:app --host 127.0.0.1 --port 8018 --reload`，另运行 `npm run dev -- --strictPort`，访问 http://127.0.0.1:5188 ，前端热更新并通过同源代理访问 8018。

如果复用 VPS 上已登录的 Gateway，可先运行 `./deploy/dev-gateway-tunnel.sh`。本机 `.env` 使用 `IB_HOST=127.0.0.1`、`IB_PORT=14001`、`IB_CLIENT_ID=72`；编号不能与服务器工作台的 71 重复。该脚本仅建立私有 SSH 转发，不修改服务器、不启动新 Gateway；需保持隧道进程运行。

## 修改工作台密码

登录弹窗下方点击“修改工作台密码”，或登录后点击右上角钥匙按钮。输入当前工作台密码、新密码及确认密码；新密码须为 6–512 个字符且不能与当前密码相同。忘记当前密码时，此功能不能绕过验证。

`DESK_PASSWORD` 仅作为初始密码；首次改密后，以 `DESK_DB` 数据库 `credential` 表中的加盐 PBKDF2-SHA256 哈希（600,000 次迭代）为准。新密码不写入 `.env`、日志或前端存储，重启后继续有效；不能再用旧 `.env` 密码登录。数据库应随部署保留/备份；Docker 的 `/data` 持久化卷已覆盖它。本地与服务器各自保存密码，不会自动同步。

改密成功后所有旧会话立即失效，需要用新密码重新登录。改密与登录共享每来源 IP 的 5 分钟 8 次失败限制，并验证同源请求。这只管理工作台访问，不修改 IBKR、VNC 密码或任何券商权限。

## IBKR 配置

1. 安装并登录官方 IB Gateway 或 TWS，完成 IBKR 身份验证。账号密码只输入官方程序。
2. 启用 Socket API，并允许工作台所在主机连接。网关 API 端口保持本机/私有网络可见。
3. 在 `.env` 设置 `IB_HOST`、`IB_PORT`、`IB_CLIENT_ID`。常见默认端口为 Gateway 模拟 4002 / 实盘 4001；TWS 模拟 7497 / 实盘 7496，以网关设置为准。
4. 有多个账户时，必须设置 `IB_ACCOUNT`。单账户可以自动选择。
5. 页面登录后点击“连接 IB Gateway”。只读模式同步账户、持仓和行情，不查询需要写权限的委托接口；当前可见成交独立同步。Gateway 中保持 Read-Only API 勾选。IB_CLIENT_ID 必须大于 0，以免触发手动委托自动绑定。
6. 确认行情订阅和 API 权限。`IB_DATA_MODE=real` 请求实时行情；`delayed` 明确请求延迟行情，是否返回仍由 IBKR 决定。报价仅供查看，本工作台没有下单功能。

Gateway 需要图形登录环境和周期性重新认证。本项目不替你保存 IBKR 密码、不绕过 2FA、不安装无人值守登录工具。同一用户名在其他交易客户端登录可能影响网关会话。

## 只读边界

- 实盘与模拟盘采用同一限制，`can_order` 固定为 `false`，`read_only` 固定为 `true`；下单、改单、撤单、行权、提现、转账权限全部为 `false`。
- 前端保留行情、完整持仓、账户全景和历史记录，原交易表单改成报价详情。旧版订单历史继续保存在 SQLite，仅可查看，不清空数据。
- 删除原 `OrderService` 与券商 `placeOrder` / `cancelOrder` 调用，不提供通用 IBKR RPC、Client Portal 资金接口或配置写入接口。
- HTTP 写方法只允许 `POST /api/session`、`DELETE /api/session`、`POST /api/password`、`POST /api/connect`，以及 `POST /api/flex/config`、`POST /api/flex/sync`、`POST /api/executions/import`。新增接口只保存本地配置、下载报表或导入成交。其余 API 写请求在路由前拒绝；旧版预览、提交、撤单地址也不能调用。
- `DESK_PAPER_ORDERS` / `DESK_MAX_ORDER_USD` 已移除，部署环境即使遗留旧值也不会启用交易。Gateway 的 Read-Only API 应始终保持勾选，工作台不修改这项设置。
- “只读”指不修改券商账户、资产或委托。登录会话、行情缓存和收到的券商回报仍可保存在本服务，连接/取消行情订阅只管理数据读取。
- 这不等于读取 IBKR 账户全部历史。多年成交可通过只读 Flex / 报表补齐；出入金、税务与收益报表尚未接入。

## 账户数据口径

- 兼容 IBKR 新版 `$LEDGER-` 前缀和旧版币种字段。账户账本优先用于汇总未实现/已实现盈亏，订阅 `reqPnL` 获取当日盈亏；两个数据流的重置规则可能不同，已实现盈亏不标记为“开户以来总收益”。
- 总额使用 IBKR 报告的基础币种；分币种账本单列，BASE 汇总不会与 USD/HKD 等明细重复相加。无法确定或未收到有效值显示横线，零值正常显示，不用其他币种或旧缓存填补。
- `positions` 与 `updatePortfolio` 通过合约编号关联，显示数量、估值价、市值、成本和盈亏。期权均价按券商合约乘数换算，浮盈亏百分比为盈亏 / 成本绝对值（不是保证金收益率）。`reqPnLSingle` 只对已持仓合约订阅，平仓后取消；非基础币种合约暂不展示当日盈亏，避免无币种信息时混用金额。
- 断线清除账户估值与订阅状态，重连重新读取。账户持仓估值和可交易实时买卖报价属于不同数据源：无 API 行情订阅仍可能读到账户估值，不能据此宣称有实时报价权限。
- `#orders` 展示当前账户已归档的最近 200 笔成交。Gateway 的新成交和佣金更新会自动保存，手动同步限频 15 秒。旧成交从 Flex / 报表补充；不从当前持仓快照倒推日期。
- 原始字段默认折叠，可搜索字段名/币种/来源，保留账户更新与 AccountSummary 的口径。上述读取不会关闭 Gateway 的 Read-Only API，也不会放开实盘交易。

官方说明：[币种字段前缀](https://www.interactivebrokers.com/docs/tws-api/doc/tws-settings/per-currency-account-value-prefix)、[账户与持仓更新](https://www.interactivebrokers.com/docs/tws-api/doc/account-portfolio-data/account-updates/receiving-account-updates)。

## K 线上的买卖记录

股票 / ETF 的 K 线显示绿色 B 买入箭头、橙色 S 卖出箭头，可隐藏或手动同步成交。悬停对应 K 线显示数量、价格和美东时间；展开明细后可定位到该笔成交的 K 线。同一根 K 线的同方向成交合并标记，箭头位于数量加权均价，明细保留原始每笔成交。

图表分页加载当前标的全部已归档成交，不受订单页最近 200 笔限制，按股票类型、USD、代码和可用合约 ID 匹配；期权成交不会标在同代码的正股上。按美东时间（含夏令时）匹配实际返回的 K 线，常规时段过滤盘前盘后，不会把缺失 K 线或区间外成交挪到邻近日期。加载更早行情后自动重新匹配。历史行情可能经过拆股调整，成交价保留券商原始成交口径。

持仓均价不能还原成交日期；未成交委托也不是成交。没有返回记录时显示明确空状态，不补造买卖点。多年前的完整买卖记录需用户提供对应日期的 Flex / 报表；该入口已接入，不新增交易权限。

## 数据与资源

只有一个 SQLite 文件（运行时附带 SQLite WAL 文件）。最多保留 500 个历史查询缓存条目，按访问需求获取行情。历史可用范围和权限由 IBKR 决定；没有预装历史数据。1m 默认回看 5 天，5m/15m 一个月，1h 三个月，日线一年；可指定结束日期。拖动到图表左侧边缘或点击“加载更早”可分页补采，追加数据时保留可见位置。每日页面使用独占日期游标，日内页面使用 Unix 秒游标。数据按标的、周期、时段和分页边界分别缓存：最新页有效期 60 秒，已结束的历史页 24 小时，超过 500 页淘汰最旧条目。刷新网页后仍可复用 SQLite 缓存。请求超时、权限不足或空页会保留已有 K 线并允许重试，不会误报已经到达历史起点。

IBKR 至网页分两段：券商数据由网关事件更新；网页每 2.5 秒读取服务的当前快照。不是高频交易或逐笔行情终端。行情使用 `TRADES`，不将其标注为总回报复权序列。所有时间展示为美东，数据库事件时间为 UTC。

## 独立部署（Linux VPS）

一套 Compose 启动两个容器：`desk`（网页/API/SQLite）和 `gateway`（官方 IB Gateway/轻量桌面/noVNC）。镜像在本地或 CI 构建，服务器只接收镜像，不安装 Node 或构建依赖。Gateway 容器采用官方 IB Gateway 10.50 Stable 安装包，无自动输入 IBKR 密码程序。

### 构建与安装

1. 从 [IBKR 官方下载页](https://www.interactivebrokers.com/en/trading/ibgateway-latest.php?p=stable) 下载 Linux x64 Stable 安装包，保存到 `.build/ibgateway-installer.sh`。安装包不进 Git 或应用镜像。
2. 按 `deploy/gateway.Dockerfile` 中记录的 SHA256 校验安装包。官方 Stable URL 会变动，更新版本时需重新审核并更新固定校验值。
3. 构建并导出：

```sh
docker build --platform linux/amd64 -t ibkr-desk:20260930 .
docker build --platform linux/amd64 -f deploy/gateway.Dockerfile -t ibkr-gateway:20260930 .
docker save ibkr-desk:20260930 ibkr-gateway:20260930 | gzip > .build/ibkr-desk-images.tar.gz
```

4. VPS 部署目录为 `/opt/ibkr-desk`，只需 `compose.yaml`、私有 `.env`、`secrets/gateway-password` 和镜像包。
5. `.env` 使用 `secrets/server.env` 的内容，包含工作台密码、镜像版本与连接配置；`secrets/gateway-password` 是远程桌面密码，与券商密码无关。目录权限 700，`.env` 权限 600。远程桌面密码文件在私有目录内设为 444，以便非 root 容器读取。

```sh
cd /opt/ibkr-desk
gunzip -c ibkr-desk-images.tar.gz | docker load
docker compose up -d
docker compose ps
```

### 访问与首次登录

在 Mac 运行（保持终端打开）：

```sh
./deploy/open-tunnel.sh root@192.210.241.6
```

- 工作台：http://localhost:18018/ ，使用服务器 `.env` 中的 `DESK_PASSWORD`。
- Gateway 桌面：http://localhost:18080/vnc.html ，点击 Connect，输入 `secrets/gateway-password`。
- 在远程桌面的官方 Gateway 登录窗口选择 **IB API**，按需选择 Live Trading 或 Paper Trading，亲自输入券商账号密码并完成手机验证。项目不保存这些凭据。
- 登录 Gateway 后检查 API 设置：初次接入保持 Read-Only API；Socket Port 实盘为 4001、模拟为 4002（如果实际配置不同，需对应调整）。允许 localhost 连接。
- 工作台 Compose 内部使用 `IB_HOST=gateway`：`IB_GATEWAY_RELAY_PORT=5001` 转发到 Gateway 的 4001，`5002` 转发到 4002。选择模拟账户时修改服务器 `.env` 的 relay port 为 5002 后执行 `docker compose up -d desk`。不向公网发布这些 API 端口。
- 返回工作台点击“连接 IB Gateway”，核对账户。实盘与模拟账户均固定只读，不能通过环境变量启用交易。

宿主机网页 8018、远程桌面 6080 都只监听 127.0.0.1。SSH 隧道断开只影响当前访问，不会停止服务器；电脑重启后重新运行隧道脚本即可。VNC 协议密码有效长度为 8 字符，因此外部连接必须保持在 SSH 隧道内，不应公开远程桌面端口。

### 公网工作台入口

- 地址：**https://ibkr.192-210-241-6.sslip.io/** 。浏览器直接访问服务器，不需要 Mac SSH 隧道；仍需工作台访问密码。
- 这是免费 IP 映射域名，依赖 sslip.io 的 DNS 服务，不是已购买的专属域名。服务器 IP 改变时需要更新域名、证书和反向代理配置。
- 公网 443 由 Nginx TCP 路由按 TLS SNI 分流：工作台域名转到 `127.0.0.1:9443` 的 HTTPS 后端，其余流量转到 `127.0.0.1:1443` 的原 VPN。客户端 VPN 配置保持原公网 443；旧工作台 `:8443` 入口和 HTTP 80 自动跳转到不带端口号的 HTTPS 地址。
- TCP 路由配置为 `deploy/tls-router.nginx.conf`，服务器存放于 `/etc/nginx/stream-conf.d/ibkr-desk.conf`，由主配置在 `http` 块之外 include，需要 `libnginx-mod-stream`。路由向后端传递 PROXY protocol；HTTPS 后端仅信任 loopback 的真实来源地址，Xray 的原入站改为 loopback 1443，并开启 `streamSettings.sockopt.acceptProxyProtocol=true`。VPN UUID、密钥、SNI 等参数未修改，也不保存到项目仓库。
- 旧 VPN 订阅的 IP 地址加 `:8443` 入口保持独立；只重定向工作台域名。证书验证目录和现有续期机制保持有效。
- Nginx 配置位于 `deploy/ibkr-desk.nginx.conf`，部署到服务器 `/etc/nginx/sites-available/ibkr-desk` 并链接到 `sites-enabled`。不对外开放 Gateway 桌面或券商 Socket API。
- HTTPS 证书名 `ibkr-desk`，由现有 `/opt/clash-certbot/bin/certbot` 管理；已有 `clash-certificate-renew.timer` 执行所有证书的续期，已有 deploy hook 自动检查并重载 Nginx。
- 服务器私有 `.env` 的 `FORWARDED_ALLOW_IPS` 包含 `127.0.0.1,::1,172.18.0.1`，其中最后一项是当前 Docker 网络的宿主机网关。Uvicorn 只信任这些地址的转发头；Nginx 覆盖客户端伪造的来源和协议头。应用才能正确校验 HTTPS Origin、设置 Secure Cookie，并按真实来源限制登录尝试。
- 重建 Docker 网络后，用 `docker network inspect ibkr-desk_default --format '{{json .IPAM.Config}}'` 核对网关 IP，必要时更新该环境变量并 `docker compose up -d desk`。不要配置为 `*`。
- 远程桌面首次登录仍使用上一节 SSH 隧道，桌面密码与工作台密码相互独立。

### 运行与维护

- `desk-data` 持久保存 SQLite；`gateway-data` 保存 Gateway 设置/日志。更新使用 `docker compose up -d`，不要使用 `down -v`（会删除数据）。
- 桌面健康检查只表明登录窗口可访问，不代表券商账户已登录。工作台“IBKR 已连接”才表示账户同步完成。
- 网关异常退出会重启容器并重新显示登录界面。重启不能替代身份验证；官方 Gateway 的每日自动重启与会话恢复需要在首次登录后实测；周末、容器重建或会话失效后可能需要重新登录。
- 容器配额：工作台 384 MB / 1 CPU，Gateway 1536 MB / 1 CPU、JVM 最大堆 768 MB。配额不等于实际占用，登录后的行情订阅会增加资源消耗。
- 工作台只运行一个 Uvicorn worker；Gateway API 仅在专用 Docker 网络内部连通。现有代理/VPN端口不作修改。
- 排查命令：`docker compose ps`、`docker compose logs --tail=80 desk gateway`。日志可能包含账户标识，不应公开上传。

## 验证

```sh
uv run pytest -q
npm test
npm run build
```

测试使用隔离的假券商适配器，验证鉴权、缓存、跨币种盈亏、期权乘数、只读成交同步；验证实盘与模拟盘都拒绝交易/资金写请求，遗留开关不生效，以及券商适配器只调用读取或连接管理接口。假数据只存在测试代码中，网页和运行服务无演示行情。没有真实 IBKR 账户接入前，不能把自动测试通过当作完成实盘联调。

## 后续阶段

1. 持续核对账户、持仓和行情权限，完善断线恢复与数据状态提示。
2. 扩展 Flex 出入金、企业行动和长期对账；当前已支持逐笔成交与佣金归档。
3. 扩展只读分析与历史资产曲线，保持全部券商操作入口关闭。

相关官方文档：[IB Gateway](https://www.interactivebrokers.com/docs/tws-api/doc/architecture/the-trader-workstation/the-ib-gateway)、[行情权限](https://www.interactivebrokers.com/docs/general/market-data-subscriptions/introduction)。客户端适配器：[ib_async](https://github.com/ib-api-reloaded/ib_async)。


## 历史买卖点：Flex / 报表导入

页面入口：订单记录 →「补齐历史成交」，或 K 线下方 →「导入历史成交」。首次操作需登录工作台并连接 Gateway，确保报表归入当前 IBKR 账户。

### IBKR 端一次性准备

1. Client Portal → Performance & Reports → Flex Queries → 创建 Activity Flex Query。
2. 添加 Trades，明细级别使用 **Executions**。包含 Account ID、IB Execution ID、Symbol、Conid、Asset Category、Currency、Date/Time、Buy/Sell、Quantity、Trade Price、Exchange。建议加入 IB Commission / IB Commission Currency、Notes/Codes 与 Original Trade ID，以识别费用和撤销更正记录。
3. 日期格式使用 `YYYYMMDD`，时间 `HHMMSS`，在工作台选择与报表一致的时区（默认美东）。也接受含 UTC 偏移的 ISO 时间。仅有日期的记录不会虚构盘中成交时间。
4. 可直接导出 XML / CSV 并导入；不支持普通活动对账单 CSV、订单汇总或 Closed Lots。
5. 在线同步需在 Flex Web Service 启用 Token，并填写 Token 和 Query ID。可请求最近 1–365 天；实际数据范围取决于 IBKR 权限、可用报表和查询模板。更早的记录按可导出的日期分段导入。

官方说明：[SendRequest](https://www.interactivebrokers.com/docs/web-api/api-reference/send-request)、[GetStatement](https://www.interactivebrokers.com/docs/web-api/api-reference/get-statement)。在线同步只访问 IBKR 固定 HTTPS 地址，不访问报表响应里的任意 URL。每次同步间隔至少一分钟，后台有限次重试，页面显示进度和失败原因。

### 数据与边界

- SQLite `executions` 按账户 + IB Execution ID 去重，数据库和 Docker 数据卷与行情缓存共用，重启后保留。Gateway 当天可见成交也会落库。
- Flex Token 按账户保存于私有 SQLite 的 `flex_settings` 表，受数据库文件 `0600` 权限保护；未做字段级加密。接口只返回是否已配置，永不返回 Token。浏览器不保存在 localStorage，仓库不保存凭据。
- 当前部署是本地开发环境；本地填写的 Token 不会自动复制到 VPS。迁移时需迁移私有数据卷或在对应实例重新填写。
- 支持 CSV / XML，UTF-8，单文件最多 10 MB / 50,000 笔。解析验证完成后原子写入。其他账户、订单汇总跳过并报告数量；缺必填字段、中途坏行、撤销/更正报表标志会拒绝整次导入，保留已有记录。IB execution ID 末段更正序号自动取最新版本，旧 Gateway 缓存不覆盖已导入报表。
- 已归档记录的起止日期不等于完整覆盖；持仓转入、企业行动、遗漏报表、超出 IBKR 可提供范围都可能仍缺原始买点。不会用持仓均价或当前日期补造买点。
- K 线只匹配 USD 股票 / ETF，期权成交不会画到同名股票。按实际成交时间映射美东 K 线，可切换盘前盘后；区间外成交可跳转到最近成交日期。原始成交价和拆股调整后的行情可能有差异。
- 未增加券商交易或资金权限；仍需在 Gateway 保持 Read-Only API。
