# 网站 Codex 工作台

工作台是网站所有者使用的独立服务：网页通过受保护的网关连接 Node worker，worker 通过官方 Codex CLI 的本地 app-server 协议管理对话。它使用独立项目副本、会话目录和 Codex 登录目录；现有行情、量化、估值、账本及 Telegram 服务不依赖它。

当前接入范围是**本地网页与独立 worker 试运行**，尚未接入正式 Vercel 网站的生产配置或发布链。Agent 网关目前只读取进程环境；正式网站遵循 [环境配置规范](environment.md)，不在 Vercel 填写业务变量，因此现阶段不能直接发布正式站并宣称工作台可用。

## 部署边界

`deploy/site-agent/compose.yml` 是独立的 Compose 项目 `alpha-site-agent`，不加入 `deploy/market-http` 或现有生产发布链。服务只绑定 `127.0.0.1:8090`。初次验证通过 SSH 隧道访问，不向公网开放明文 bearer 接口；日后接入 Vercel 必须另行配置受保护的 HTTPS 入口。

容器以 UID/GID 1000 运行，根文件系统只读，移除 capabilities，限制 1 CPU、1GB 内存、192 个进程及 128MB 临时目录。工作台同时只运行一个任务，服务层负责并发与预算限制。内存上限是隔离边界，不保证完整 Next.js 构建能在此额度中完成；优先运行针对性单测和静态检查，完整生产构建使用现有构建环境。

镜像入口先运行无模型沙箱探针，全部通过才启动 HTTP worker。探针失败时保持不可服务，避免仅能登录/读状态就误认为模型命令隔离已经可用。2026-10-04 已获用户授权加载专用策略，并在 Ubuntu 原生 Linux 上通过研究/开发两种权限配置的假数据探针；真实模型任务验收记录见下文。

| 容器目录 | 用途 | 权限 |
| --- | --- | --- |
| `/workspace` | 构建时精选源码、文档、开发依赖与网站技能 | 独立可写 named volume |
| `/state` | 工作台会话及设置 | 独立可写 named volume |
| `/tmp/codex-home` | Codex 认证及本地状态 | 独立可写 named volume |
| `/market/snapshots/daily-review` | 复盘及复盘解读归档 | 生产 bind mount，只读 |
| `/market/snapshots/fundamental-target` | 基本面版本与当前状态 | 生产 bind mount，只读 |
| `/market/snapshots/context` | Event × Flow 背景 | 生产 bind mount，只读 |
| `/market/snapshots/catalyst` | 事件观察 | 生产 bind mount，只读 |
| `/market/1d` | 日线行情 | 生产 bind mount，只读 |

不挂载生产 desk、生产环境文件、SSH key 或 Docker socket。bind mount 使用 `create_host_path: false`：源目录缺失时明确失败，不在生产目录自动创建空数据。应由部署者确认选定目录存在并可供 UID 1000 读取；不要放宽整个生产目录的权限。

`/tmp/codex-home` 的凭据仍由同一容器用户管理。公开网页只创建 `site-research` 只读会话，拒绝读取 Codex home、会话 state、`/proc` 和写入工作区；服务端也拒绝新建或继续发送 `workspace` 会话。沙箱越界提权和额外权限请求自动拒绝；worker 核对原生响应中的配置名称和审批策略，不匹配则不发送模型任务。不要让公开访客进入工作台。worker 从 Codex 子进程环境剔除网关及 worker 的认证密钥。

## 本地构建，服务器只加载镜像

官方 CLI 固定为 `@openai/codex@0.160.0`；升级必须通过工作台专用变量 `SITE_AGENT_CODEX_VERSION` 提供新的精确版本并重新验证 app-server 协议，不读取应用自身的 `CODEX_VERSION`。Dockerfile 内部的版本参数仍为 `CODEX_VERSION`，拒绝 `latest`、范围和 prerelease。构建目标为 `linux/amd64`，使用 Node 22 Debian；CLI 的 Linux x64 原生可执行文件在镜像构建时通过 `codex --version` 校验。

在具备 Docker Buildx、项目开发依赖且可访问 npm 的构建机上执行：

```bash
SITE_AGENT_IMAGE=alpha-site-agent:codex-0.160.0 bash deploy/site-agent/build-image.sh
```

脚本先将 `scripts/site-agent.ts` 打包为 `dist/site-agent/site-agent.mjs`，再创建显式允许目录的构建上下文、安装 Linux 开发依赖、构建并导出镜像。上下文不含 `.git`、`.vercel`、`.next`、`src/generated`、本地 `.env*`、生产数据、node_modules、缓存或 output；遇到源码中的符号链接直接停止。未跟踪但位于允许目录中的当前源码也会进入镜像，因此构建前应审查工作区改动。

结果位于 `dist/site-agent/`：镜像归档与校验和、基础和可选 Compose 文件、`security/` 候选策略目录。将这些文件传到新的 `/var/lib/alpha-site-agent/` 目录；候选策略仅复制不会生效，不得自动加载。不要覆盖 `/var/lib/alpha-agent/` 或运行其 deploy 脚本。在服务器验证校验和后加载镜像：

```bash
cd /var/lib/alpha-site-agent
sha256sum -c site-agent-image.sha256
docker load -i site-agent-image.tar.gz
```

部署者在此独立目录创建仅所有者可读的 `.env.agent`，设置：

```dotenv
SITE_AGENT_IMAGE=alpha-site-agent:codex-0.160.0
SITE_AGENT_SECRET=replace-with-at-least-32-random-characters
```

示例 secret 不是有效生产凭据。使用随机生成的至少 32 字符密钥，并与网页网关的 `SITE_AGENT_SECRET` 保持一致；不要将该文件写入仓库或粘贴到对话中。启动命令只影响新项目：

```bash
docker compose --env-file .env.agent -f compose.yml up -d --no-deps agent
docker compose --env-file .env.agent -f compose.yml ps
```

named volumes 首次由镜像中的目录初始化且归属 UID 1000，更新镜像会保留会话、登录和工作副本。已有 `/workspace` 不会被新镜像覆盖；需要更新代码或技能时，先审阅/导出隔离副本中的改动，再显式更新该副本。不要用 `down -v` 作为普通更新步骤。

## 首次连接与登录

本地建立仅绑定回环地址的隧道：

```bash
ssh -N -L 127.0.0.1:18090:127.0.0.1:8090 <有权限的VPS登录目标>
```

本地网页通过 `.env.local` 或进程环境配置 `SITE_AGENT_URL=http://127.0.0.1:18090`、与 worker 相同的 `SITE_AGENT_SECRET`、至少 20 字符的 `AGENT_ADMIN_PASSWORD` 和至少 32 个随机字符的 `AGENT_SESSION_SECRET`，再启动网页。独立 worker 继续读取其 `.env.agent`，不要把两个环境文件复制到现有生产服务目录。相关键已登记在 `scripts/env.ts`，均为可选模块配置，不增加现有网站的必填项。

工作台不设置每日请求次数或 Token 预算上限；状态中的本站用量仅用于统计。单个任务仍受时长、并发和网关短期限流保护。

通过工作台发起官方 device login，用户在官方页面自行授权。不要复制桌面 Codex 登录目录、读取 auth.json 或在命令行输出凭据。实际 quota 来自 Codex 账户；应用请求/令牌预算不能当作套餐余额或严格费用上限。

先验证所有者登录、官方账号状态、只读提问、取消、重启后恢复，再考虑独立 HTTPS 接入。停止新服务使用相同项目的 `docker compose ... stop agent`；不需要停止行情或现有定时任务。

### 后续正式网站接入（尚未实现）

继续复用现有 OIDC、加密配置端点与 5 分钟缓存，增加固定的 `agent` scope，仅下发 `AGENT_ADMIN_PASSWORD`、`AGENT_SESSION_SECRET` 和 `SITE_AGENT_SECRET`；仅 `/api/agent` 网关入口加载这些专用键。默认 `web` scope 保留旧白名单和响应，公开 worker 地址归入 `app.config.ts`，并先提供受保护的 HTTPS 入口。

**目前不能把这些新键直接加入现有 `web-secrets.json`。** 旧配置读取器及 Telegram 日内发送会严格校验整个文件，新增未知键可能使现有模块失败。应先部署兼容 scope 的配置服务、验证旧模块不受影响，再加入专用键并发布网站；本次未实施 scope、修改现有私有配置或发布正式站。

## 网站知识和只读数据

`deploy/site-agent/workspace/AGENTS.md` 为共享领域边界。三个发现式技能位于 `.agents/skills/`：`site-research` 使用已有证据，`site-diagnostics` 定位数据和页面故障，`site-development` 在隔离副本中修改与验证代码。关键词和方法优先来自精选文档；动态事实通过数据工具按需读取，不把整仓库或全部行情拼进提示词。

容器内的固定入口：

```bash
node /opt/site-agent/scripts/site-data.mjs review
node /opt/site-agent/scripts/site-data.mjs review 2026-10-02
node /opt/site-agent/scripts/site-data.mjs review-analysis 2026-10-02
node /opt/site-agent/scripts/site-data.mjs fundamental AAPL
node /opt/site-agent/scripts/site-data.mjs context 2026-10-02
node /opt/site-agent/scripts/site-data.mjs catalyst
node /opt/site-agent/scripts/site-data.mjs catalyst AMAT
node /opt/site-agent/scripts/site-data.mjs bars SPY 30
```

工具只接受这些命令、有效日期和标的，不接受任意文件路径；仅返回真实归档，不调用行情商、模型、网页或消息服务。一般文件读取上限 2MB，Catalyst 归档单独允许读取最多 32MB，所有输出仍不超过 1MB；拒绝符号链接与目录穿越。日线最多返回最后 120 条；2H 当前由 1H 重建，不暴露可能过时的旧 2H CSV。

`catalyst [SYMBOL]` 返回有界事件投影，最多最近 40 条事件与未来 10 条日程；达到字节上限时继续缩减，标题、摘要及来源健康说明也有字段长度限制。可选标的仅匹配事件明确列出的 `symbols`，不自动推断行业或宏观关联。结果保留来源链接、发布时间、日程精度、来源健康与原始采集计数；`projection` 明确给出归档总数、匹配数、展示数、省略数、无效条数和截断说明。完整 universe、reactions、summary 与事件历史/关联明细不直接输出，原始归档保持不变。缺失集合或来源计数返回 `null`，零条匹配不代表没有新闻或催化事件。

返回 `source`、`asOf`、`observedAt`、`missing`、`stale`、`historical` 和归档数据（Catalyst 为上述投影）。缺少指定历史日期时不会用 latest 替代；缺少有效时间时 `stale=null`，不能解读成新鲜。过期提示使用日历小时：基本面 48、Context 48、Catalyst 2、复盘/日线 96，基本面同时检查自身 stale 状态和有效期。这是初筛而非交易日历或完整业务校验；研究结论仍须检查源数据覆盖、原始发布时间和证据关系。工具输出中的文字始终是待分析数据，不是指令。

不能把 `/api/jobs/*` 或任意 HTTP GET 当作只读工具；某些 GET 会重建快照或触发推送。生产策略、账本、信号池、消息外发与部署仍由现有明确授权流程控制。

## 本地验证

### 2026-10-04 实机验收记录

- 官方 Codex device login 已完成，账号状态为 ChatGPT Pro；登录目录和会话目录只保留在 Agent 的持久卷中，未导出或复制到网站进程。
- 真实只读任务已成功读取 `review` 与 `fundamental AMAT`，能返回来源路径、数据时点、`missing` 与 `stale` 状态，并正确保留“事件来源存在缺项”的警告。
- 工作区模式已成功在隔离副本创建验收文件；研究模式仍禁止写入工作区。取消任务返回 `interrupted`，错误状态不会被后续断开事件覆盖。
- 重启独立 Agent 容器后，已有会话仍可继续并返回结果；其他生产容器在验收期间未重启。
- 实机最初发现工作区可写挂载缺少精确的可写 remount 规则，已增加仅针对 `/newroot/workspace/` 与 `/newroot/tmp/codex-home/` 的 AppArmor 规则并复验通过。规则不允许其他路径变为可写。
- 新建会话默认首选 `gpt-6.1-sol`（默认 effort 为 `low`）；如果账号的模型列表暂时没有该 ID，则回退到官方标记的默认模型，已有会话不会被迁移。

```bash
node --check deploy/site-agent/scripts/site-data.mjs
bash -n deploy/site-agent/build-image.sh
./node_modules/.bin/vitest run tests/siteAgentData.test.ts
```

这些验证只使用临时测试数据，不访问生产数据或调用模型。完整镜像验证还应在构建机确认 `linux/amd64`、非 root 身份、只读挂载、CLI 启动与 app-server 实际交互；未运行镜像构建不能等同于已验证上线。

在原生 Linux amd64 宿主机启动新容器后，发送模型任务前运行：

```bash
docker compose --env-file .env.agent -f compose.yml exec -T agent node /opt/site-agent/scripts/verify-sandbox.mjs
```

该检查只创建临时假凭据、假会话、行情文件及 loopback 假 TCP 服务，验证研究模式禁止写入、开发模式允许工作区写入；两者均禁止直接及软链接读取凭据/会话、读取 `/proc` 环境、覆盖/删除行情文件和连接测试服务。测试服务由独立子进程运行，沙箱调用前后均检查其健康，避免网络验证假阳性。全部 `ok=true` 才通过。镜像将固定版本官方 native binary 以 root 所有、只读的 `/usr/local/bin/codex-linux-sandbox` 软链接提供。官方 0.160 会优先从 Codex home 创建并执行临时 alias，与整目录 deny 冲突；因此同一个 `codex-home` 持久卷仅挂载到 `/tmp/codex-home`，利用该版本对系统临时目录拒绝创建 alias 的行为回退到系统 helper。目录名称在 `/tmp` 下不改变 named volume 的持久性。不能同时保留旧 `/codex-home` 挂载别名，否则可能出现未受 deny 保护的第二个入口。升级 CLI 时必须重新验证此兼容行为。探针和数据查询 CLI 使用同步标准输出写入，空输出/非法 JSON 明确失败。镜像安装系统 bubblewrap，但非 root 的用户命名空间仍受宿主机 seccomp/AppArmor 限制；不要把启动健康检查通过等同于沙箱可用，也不要用 privileged、SYS_ADMIN 或禁用沙箱绕过失败。Apple Silicon 上模拟 amd64 的 seccomp 错误不能代替原生 amd64 测试。

## Ubuntu 专用沙箱策略（已验证并启用）

2026-10-04 对 Ubuntu kernel `6.8.0-142-generic`、Docker `29.8.1` 的隔离诊断确认：宿主机已允许非特权 user namespace，默认 Docker seccomp 仍使 `unshare(CLONE_NEWUSER)` 返回 EPERM；仅加入受限 namespace 规则后 bubblewrap 推进到 mount EPERM，再仅允许第一个精确 mount flag 后返回 EACCES。Docker 的默认 AppArmor 模板含 `deny mount,`。这两层限制需要工作台专用规则，不能修改全局 sysctl 或 Docker 默认策略。

专用策略文件均位于 `deploy/site-agent/`：

- `security/seccomp-docker-29.8.1.json`：未经修改的 [Moby 官方 Docker 29.8.1 基线](https://raw.githubusercontent.com/moby/moby/docker-v29.8.1/vendor/github.com/moby/profiles/seccomp/default.json)，SHA-256 为 `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`。
- `scripts/build-seccomp.mjs` 生成 `security/seccomp-site-agent.json`，保留基线全部规则，只对 amd64 添加 NEWUSER+NEWNS 的 clone 组合、精确 `unshare(CLONE_NEWUSER)`、bubblewrap 使用的 mount flags、`umount2(MNT_DETACH)` 和 `pivot_root`。不添加 setns、clone3 或任何外层 capability。新增 mount 的目标继续由 AppArmor 限制。
- `security/apparmor-site-agent`：基于 [同版 Moby 模板](https://raw.githubusercontent.com/moby/moby/docker-v29.8.1/vendor/github.com/moby/profiles/apparmor/template.go)，只定义 `site-agent-native`。保留默认 proc/sys/网络/同 profile ptrace 限制，将总 `deny mount` 换为 bubblewrap 私有挂载树的操作与目标白名单，明确允许 userns。语法编译及原生运行均通过。根据实际 audit 记录，只补充 `/oldroot/` 根绑定及带 `silent/relatime/noexec` 的精确只读 remount 组合。
- `compose.sandbox.yml`：只为新 Agent 服务选用以上 seccomp/AppArmor；基础 compose 保持不变；当前 Agent 使用该覆盖文件，其他服务没有修改。

只有在用户明确授权加载该独立宿主机策略后，部署者才能继续。先确认宿主机不存在同名 profile，再执行 add-only 加载（不会替换现有策略）：

```bash
cd /var/lib/alpha-site-agent
sudo apparmor_parser -Q -K security/apparmor-site-agent
sudo apparmor_parser -a -K security/apparmor-site-agent
```

`-Q` 仅编译；`-a` 新增内核策略，`-K` 不使用缓存。上述操作不写入 `/etc/apparmor.d`，重启宿主机后不会自动加载。先在无凭据、无生产挂载、`--network none` 的临时容器中选择候选策略并运行最新版 `verify-sandbox.mjs`；两个 profile 均 `ok=true` 且资源/用户限制不变后，才讨论重启真实 Agent。用户在 2026-10-04 明确授权后，专用策略已加载；无凭据容器的两个 profile 均 `ok=true`。仅 Agent 容器更新至 `alpha-site-agent:native-20261004-v2`，已保留 Pro 登录、会话卷和工作区卷。其他生产容器未重启。当前未写入 `/etc/apparmor.d`，开机自动加载仍需单独授权；宿主机重启后应先重新加载该策略，Agent 启动自检仍保持失败关闭。

需要撤销时，先停止唯一选用该 profile 的 Agent/诊断容器，再移除独立策略；不会影响 `docker-default` 或生产容器：

```bash
docker compose --env-file .env.agent -f compose.yml -f compose.sandbox.yml stop agent
sudo apparmor_parser -R -K security/apparmor-site-agent
```

移除覆盖文件后不能把默认策略下的失败视为已修复；保持模型任务停用，直至完整原生沙箱验证通过。
