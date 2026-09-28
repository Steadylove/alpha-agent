import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

export type Environment = Record<string, string | undefined>;

/** Match Next's file precedence. An explicitly injected empty value still wins. */
export function readEnvironment(options: {
  cwd?: string;
  env?: Environment;
  file?: string;
} = {}) {
  const cwd = options.cwd ?? process.cwd();
  const inherited = options.env ?? process.env;
  const explicit = options.file ?? inherited.DOTENV_CONFIG_PATH;
  const mode = inherited.NODE_ENV || "development";
  const names = explicit ? [explicit] : [
    `.env.${mode}.local`,
    ...(mode === "test" ? [] : [".env.local"]),
    `.env.${mode}`,
    ".env",
  ];
  const values: Environment = { ...inherited };
  const origins: Record<string, string> = {};
  const definitions: Record<string, string[]> = {};
  const fileValues: Record<string, string> = {};
  const conflicts = new Set<string>();
  const files: string[] = [];
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) origins[key] = "process";
  }
  for (const name of names) {
    const file = path.resolve(cwd, name);
    if (!existsSync(file)) continue;
    let parsed: Record<string, string>;
    try { parsed = parse(readFileSync(file)); }
    catch { throw new Error(`无法读取配置文件：${path.basename(file)}`); }
    files.push(name);
    for (const [key, value] of Object.entries(parsed)) {
      (definitions[key] ??= []).push(name);
      if (key in fileValues && fileValues[key] !== value) conflicts.add(key);
      fileValues[key] ??= value;
      if (values[key] === undefined) {
        values[key] = value;
        origins[key] = name;
      }
    }
  }
  return { values, origins, definitions, conflicts: [...conflicts].sort(), files };
}

export function loadLocalEnvironment() {
  const result = readEnvironment();
  for (const [key, value] of Object.entries(result.values)) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}

type Entry = {
  group: string;
  description: string;
  profiles: string[];
  secret: boolean;
  default?: string;
  aliasFor?: string;
  requiredFor?: string[];
  allowed?: string[];
  positiveInteger?: boolean;
  nonnegativeInteger?: boolean;
};

const catalog: { variables: Record<string, Entry>; retired: Record<string, string>; platformPrefixes: string[]; profiles: string[] } = {
  variables: {
    "ALPACA_API_KEY": {"group": "数据源", "description": "Alpaca Key ID；与 Secret 成对配置", "profiles": ["daily"], "secret": true, "requiredFor": ["daily"]},
    "ALPACA_API_SECRET": {"group": "数据源", "description": "Alpaca Secret；与 Key ID 成对配置", "profiles": ["daily"], "secret": true, "requiredFor": ["daily"]},
    "ALPACA_FEED": {"group": "数据源", "description": "行情权限；不设置时自动选择 sip / iex，VPS 日更使用 sip", "profiles": ["daily"], "secret": false, "allowed": ["sip", "iex"]},
    "ALPACA_MAX_INFLIGHT": {"group": "数据源", "description": "Alpaca 同时在途请求上限", "profiles": ["daily"], "secret": false, "default": "3", "positiveInteger": true},
    "APCA_API_KEY_ID": {"group": "数据源", "description": "兼容别名，优先使用 ALPACA_API_KEY", "profiles": ["daily"], "secret": true, "aliasFor": "ALPACA_API_KEY"},
    "APCA_API_SECRET_KEY": {"group": "数据源", "description": "兼容别名，优先使用 ALPACA_API_SECRET", "profiles": ["daily"], "secret": true, "aliasFor": "ALPACA_API_SECRET"},
    "FMP_API_KEY": {"group": "数据源", "description": "可选：个股资料及财报日历", "profiles": ["daily"], "secret": true},
    "SEC_USER_AGENT": {"group": "数据源", "description": "SEC 请求身份，组织名及联系邮箱；事件披露采集需要显式填写", "profiles": ["daily"], "secret": false},
    "MARKET_DATA_BASE_URL": {"group": "文件与鉴权", "description": "远程行情服务；非空时行情读取优先使用远程服务", "profiles": ["web", "daily", "flow"], "secret": false},
    "MARKET_DATA_DIR": {"group": "文件与鉴权", "description": "本地行情根目录，布局为 1d / 4h / 2h / 1h / rps", "profiles": ["web", "daily", "flow"], "secret": false},
    "CRON_SECRET": {"group": "文件与鉴权", "description": "受保护任务接口密钥；兼作部分 desk 客户端鉴权的后备值", "profiles": ["web", "daily", "flow"], "secret": true},
    "DESK_STORE_SECRET": {"group": "文件与鉴权", "description": "desk 与账本服务的共享写入密钥，客户端和服务端必须一致", "profiles": ["web", "daily", "flow"], "secret": true},
    "SIGNAL_JOURNAL_DIR": {"group": "文件与鉴权", "description": "本地信号档案目录；设置后对应档案读写改为本地", "profiles": ["web", "daily", "flow"], "secret": false},
    "SIGNAL_POOL_PATH": {"group": "文件与鉴权", "description": "本地股票池 JSON 路径", "profiles": ["web", "daily", "flow"], "secret": false},
    "BOOK_EPOCH_PATH": {"group": "文件与鉴权", "description": "本地账本版本 JSON 路径", "profiles": ["web", "daily", "flow"], "secret": false},
    "LIVE_BOOKS_PATH": {"group": "文件与鉴权", "description": "本地 2H / 4H 模型账户 JSON 路径", "profiles": ["web", "daily", "flow"], "secret": false},
    "LIVE_BOOK_PATH": {"group": "文件与鉴权", "description": "本地单一连续账本 JSON 路径", "profiles": ["web", "daily", "flow"], "secret": false},
    "FUND_BOOK_PATH": {"group": "文件与鉴权", "description": "本地资金账本 JSON 路径", "profiles": ["web", "daily", "flow"], "secret": false},
    "LOOKBACK_SNAPSHOTS_PATH": {"group": "文件与鉴权", "description": "本地回看快照 JSON 路径", "profiles": ["web", "daily", "flow"], "secret": false},
    "PUSH_ROUTES_PATH": {"group": "文件与鉴权", "description": "本地推送路由 JSON 路径", "profiles": ["web", "daily", "flow"], "secret": false},
    "OPTION_FLOW_PATH": {"group": "文件与鉴权", "description": "本地期权流记录 JSON 路径", "profiles": ["web", "daily", "flow"], "secret": false},
    "GEX_HISTORY_DIR": {"group": "文件与鉴权", "description": "历史 GEX 输入目录", "profiles": ["web", "daily", "flow"], "secret": false},
    "DISCORD_WEBHOOK_URL": {"group": "推送与期权流", "description": "选股频道和通用默认 webhook", "profiles": ["web", "daily", "flow"], "secret": true},
    "DISCORD_SIGNAL_WEBHOOK_URL": {"group": "推送与期权流", "description": "信号 / 账本 / GEX 默认 webhook，缺省回落通用地址", "profiles": ["web", "daily", "flow"], "secret": true},
    "DISCORD_MIRROR_4H_WEBHOOK_URL": {"group": "推送与期权流", "description": "4H 镜像默认 webhook", "profiles": ["web", "daily", "flow"], "secret": true},
    "DISCORD_MIRROR_2H_WEBHOOK_URL": {"group": "推送与期权流", "description": "2H 镜像默认 webhook", "profiles": ["web", "daily", "flow"], "secret": true},
    "DISCORD_MIRROR_BOOK_WEBHOOK_URL": {"group": "推送与期权流", "description": "账本镜像默认 webhook", "profiles": ["web", "daily", "flow"], "secret": true},
    "DISCORD_MIRROR_GEX_WEBHOOK_URL": {"group": "推送与期权流", "description": "GEX 镜像默认 webhook", "profiles": ["web", "daily", "flow"], "secret": true},
    "DISCORD_BOT_TOKEN": {"group": "推送与期权流", "description": "期权流源频道读取，以及无 webhook 时的 Bot 发送", "profiles": ["web", "daily", "flow"], "secret": true, "requiredFor": ["flow"]},
    "DISCORD_OPTION_CHANNEL_ID": {"group": "推送与期权流", "description": "期权流来源频道；有现有业务默认值", "profiles": ["web", "daily", "flow"], "secret": false},
    "DISCORD_SIGNAL_CHANNEL_ID": {"group": "推送与期权流", "description": "名单 / 热力图的 Bot 发送后备频道", "profiles": ["web", "daily", "flow"], "secret": false},
    "OPTION_FLOW_MIN_PREMIUM_USD": {"group": "推送与期权流", "description": "手动解析工具的后备金额门槛；常驻 worker 使用 /push 保存的门槛覆盖它", "profiles": ["web", "daily", "flow"], "secret": false, "default": "500000", "nonnegativeInteger": true},
    "OPTION_FLOW_DROP_ADS": {"group": "推送与期权流", "description": "过滤广告内容", "profiles": ["web", "daily", "flow"], "secret": false, "default": "true"},
    "OPTION_FLOW_DROP_PAID": {"group": "推送与期权流", "description": "过滤付费内容", "profiles": ["web", "daily", "flow"], "secret": false, "default": "true"},
    "OPTION_FLOW_POLL_MS": {"group": "推送与期权流", "description": "期权流轮询间隔，单位毫秒", "profiles": ["web", "daily", "flow"], "secret": false, "default": "3000", "positiveInteger": true},
    "OPTION_FLOW_PUSH_URL": {"group": "推送与期权流", "description": "单笔期权流交给网站推送的接口地址", "profiles": ["web", "daily", "flow"], "secret": false},
    "TELEGRAM_RELAY_URL": {"group": "推送与期权流", "description": "Telegram 中继；缺省使用行情服务地址加 /telegram", "profiles": ["web", "daily", "flow"], "secret": false},
    "TELEGRAM_RELAY_SECRET": {"group": "推送与期权流", "description": "非 Vercel 客户端的中继签名密钥；需与 Telegram 服务一致", "profiles": ["web", "daily", "flow"], "secret": true},
    "TV_INTRADAY_WEBHOOK_SECRET": {"group": "推送与期权流", "description": "仅本地 TV 日内接收接口使用；生产从 VPS telegram.config.mjs 的 intradayWebhookSecret 校验，不在 Vercel 配置", "profiles": ["web"], "secret": true},
    "TELEGRAM_ENABLED": {"group": "推送与期权流", "description": "设置 false 禁用图片入队", "profiles": ["web", "daily", "flow"], "secret": false, "default": "true"},
    "BOOK_PUSH_URL": {"group": "推送与期权流", "description": "账本卡的远程接口，同时作为 GEX 远程推送的站点 origin", "profiles": ["web", "daily", "flow"], "secret": false},
    "GEX_PUSH_URL": {"group": "推送与期权流", "description": "覆盖 GEX 单卡远程接口", "profiles": ["web", "daily", "flow"], "secret": false},
    "GEX_LOCAL": {"group": "推送与期权流", "description": "手动 GEX 工具使用本地渲染", "profiles": ["web", "daily", "flow"], "secret": false, "default": "0"},
    "GEX_TEST": {"group": "推送与期权流", "description": "手动推送加测试标记，仍会真实发送，不是 dry-run", "profiles": ["web", "daily", "flow"], "secret": false, "default": "0"},
    "DEEPSEEK_API_KEY": {"group": "独立 AI 分析", "description": "通用后备密钥；旧选股分析也用它", "profiles": ["daily"], "secret": true},
    "DEEPSEEK_REVIEW_API_KEY": {"group": "独立 AI 分析", "description": "每日复盘专用密钥，优先于通用密钥", "profiles": ["daily"], "secret": true},
    "DEEPSEEK_REVIEW_MODEL": {"group": "独立 AI 分析", "description": "每日复盘模型，同时作为其他分析的后备模型", "profiles": ["daily"], "secret": false},
    "DEEPSEEK_CATALYST_API_KEY": {"group": "独立 AI 分析", "description": "事件分析密钥，依次回落 review / 通用", "profiles": ["daily"], "secret": true},
    "DEEPSEEK_CATALYST_MODEL": {"group": "独立 AI 分析", "description": "事件分析模型，回落 review 模型", "profiles": ["daily"], "secret": false},
    "DEEPSEEK_CONTEXT_API_KEY": {"group": "独立 AI 分析", "description": "个股 Context 分析密钥，依次回落 catalyst / review / 通用", "profiles": ["daily"], "secret": true},
    "DEEPSEEK_CONTEXT_MODEL": {"group": "独立 AI 分析", "description": "Context 模型，依次回落 catalyst / review 模型", "profiles": ["daily"], "secret": false},
    "SCREENER_SKIP_AI": {"group": "独立 AI 分析", "description": "默认跳过旧选股 AI；VPS 主任务强制 true", "profiles": ["daily"], "secret": false, "default": "true"},
    "THETADATA_API_KEY": {"group": "研究与维护", "description": "Theta 本地期权研究 API Key，生产每日 GEX 不依赖它", "profiles": ["theta"], "secret": true, "requiredFor": ["theta"]},
    "THETA_PYTHON": {"group": "研究与维护", "description": "创建 Theta 虚拟环境时选用的 Python 程序", "profiles": ["theta"], "secret": false, "default": "python3"},
    "PANEL_SNAPSHOT_URL": {"group": "研究与维护", "description": "下载标普 / 纳指研究面板的快照 URL", "profiles": ["research"], "secret": false},
    "RPS_SCALE_FROM": {"group": "研究与维护", "description": "外生 RPS 标尺起始日", "profiles": ["research"], "secret": false, "default": "2021-01-01"},
    "BACKFILL_CONCURRENCY": {"group": "研究与维护", "description": "历史补采并发，因脚本不同默认 4 或 6", "profiles": ["research"], "secret": false, "positiveInteger": true},
    "SMALLFUND_REFETCH": {"group": "研究与维护", "description": "设为 1 强制重新获取已有 CSV；维护开关", "profiles": ["research"], "secret": false, "default": "0"},
    "GEX_OUTPUT_DIR": {"group": "研究与维护", "description": "Python GEX 采集器输出目录", "profiles": ["research"], "secret": false},
    "ESBUILD_CLI": {"group": "研究与维护", "description": "打包器可执行路径；不设置时使用 npx esbuild", "profiles": ["research"], "secret": false},
    "REVIEW_CARD_ASSET_DIR": {"group": "研究与维护", "description": "复盘图 logo 等资源目录", "profiles": ["research"], "secret": false},
    "REVIEW_CARD_STATE_DIR": {"group": "研究与维护", "description": "复盘图投递去重状态目录", "profiles": ["research"], "secret": false},
    "REVIEW_CARD_TELEGRAM_CONFIG": {"group": "研究与维护", "description": "出图脚本读取 Telegram 中继签名密钥的配置文件", "profiles": ["research"], "secret": false},
    "REVIEW_RETRY_SLEEP": {"group": "研究与维护", "description": "日更派生数据步骤失败重试间隔，秒", "profiles": ["research"], "secret": false, "default": "45", "nonnegativeInteger": true},
    "MARKET_REFRESH_RETRY_SLEEP": {"group": "研究与维护", "description": "行情刷新失败重试间隔，秒", "profiles": ["research"], "secret": false, "default": "45", "nonnegativeInteger": true},
    "ALPHA_ROOT": {"group": "研究与维护", "description": "补采 / Catalyst / 复盘图脚本的部署根目录；主日更仍使用固定生产根目录", "profiles": ["research"], "secret": false, "default": "/var/lib/alpha-agent"},
    "DESK_BIND": {"group": "服务及平台", "description": "desk HTTP 服务监听地址", "profiles": ["service"], "secret": false, "default": "0.0.0.0"},
    "DESK_DIR": {"group": "服务及平台", "description": "desk HTTP 服务数据目录", "profiles": ["service"], "secret": false, "default": "/data"},
    "PORT": {"group": "服务及平台", "description": "当前服务监听端口，必须按服务分别设置", "profiles": ["service"], "secret": false},
    "TELEGRAM_CONFIG_PATH": {"group": "服务及平台", "description": "Telegram 服务挂载的私有配置文件，文件内字段优先于环境变量", "profiles": ["service"], "secret": false, "default": "/config/telegram.config.mjs"},
    "TELEGRAM_BOT_TOKEN": {"group": "服务及平台", "description": "Telegram 服务无文件 token 时的后备值", "profiles": ["service"], "secret": true},
    "TELEGRAM_DATA_DIR": {"group": "服务及平台", "description": "Telegram 服务状态持久化目录", "profiles": ["service"], "secret": false, "default": "/data"},
    "VERCEL": {"group": "服务及平台", "description": "Vercel 自动注入；手动设 1 也会启用远程数据及 OIDC 分支", "profiles": ["service"], "secret": false},
    "NODE_ENV": {"group": "服务及平台", "description": "Next / CLI 的环境文件模式；未设置时 CLI 使用 development", "profiles": ["service"], "secret": false},
    "DOTENV_CONFIG_PATH": {"group": "服务及平台", "description": "CLI 指定单一环境文件；指定后不再叠加默认环境文件", "profiles": ["service"], "secret": false},
    "NODE_OPTIONS": {"group": "服务及平台", "description": "Node 运行内存等参数，由任务 / 容器设置", "profiles": ["service"], "secret": false},
    "TZ": {"group": "服务及平台", "description": "进程时区，VPS 调度使用 Asia/Shanghai", "profiles": ["service"], "secret": false},
    "FONTCONFIG_FILE": {"group": "服务及平台", "description": "出图模块自动设置的字体配置，通常不手动填写", "profiles": ["service"], "secret": false},
    "MPLCONFIGDIR": {"group": "服务及平台", "description": "Python 绘图缓存目录，研究脚本自动设置", "profiles": ["service"], "secret": false},
    "VPS_SSH_KEY": {"group": "服务及平台", "description": "GitHub Actions 的 SSH Secret，用于部署和手动补跑", "profiles": ["service"], "secret": true},
  },
  retired: {"DATABASE_URL": "数据库已移除", "ALLOW_DB": "数据库已移除", "SMALLFUND_SOURCE": "数据源已固定为文件", "FRED_API_KEY": "当前宏观数据使用不需此密钥的接口", "FINNHUB_API_KEY": "当前没有消费者"},
  platformPrefixes: ["VERCEL_", "TURBO_", "NX_"],
  profiles: ["all", "web", "daily", "flow", "theta"],
};

export const environmentCatalog: Record<string, Entry> = catalog.variables;
export const environmentProfiles = catalog.profiles;

/** Return names and states only. Never include values, lengths, hashes or parser errors. */
export function environmentReport(input: ReturnType<typeof readEnvironment>, profile = "all") {
  if (!environmentProfiles.includes(profile)) throw new Error("未知配置场景");
  const issues: { key: string; code: string; message: string }[] = [];
  const rows = Object.entries(environmentCatalog).filter(([, entry]) =>
    profile === "all" || entry.profiles.includes(profile) || entry.requiredFor?.includes(profile),
  ).map(([key, entry]) => {
    const value = input.values[key];
    const configured = Boolean(value?.trim());
    const required = entry.requiredFor?.includes(profile) ?? false;
    if (required && !configured) issues.push({ key, code: "missing", message: "当前场景需要配置此项" });
    if (configured && entry.allowed && !entry.allowed.includes(value!)) {
      issues.push({ key, code: "invalid", message: "取值不在配置字典允许的范围内" });
    }
    if (value !== undefined && (entry.positiveInteger || entry.nonnegativeInteger)) {
      const n = Number(value);
      if (!value.trim() || !Number.isSafeInteger(n) || n < (entry.positiveInteger ? 1 : 0) ||
        (key === "OPTION_FLOW_MIN_PREMIUM_USD" && n > 1_000_000_000_000)) {
        issues.push({ key, code: "invalid", message: "需要符合范围的整数；使用默认值时请移除此项" });
      }
    }
    if (key === "ALPACA_FEED" && value === "") {
      issues.push({ key, code: "invalid", message: "自动选择 feed 时请移除此项，不要配置空字符串" });
    }
    return {
      key, group: entry.group, description: entry.description, required,
      status: configured ? "configured" : value !== undefined ? "empty" : entry.default !== undefined ? "default" : "unset",
      source: input.origins[key] ?? (entry.default !== undefined ? "code" : "none"),
    };
  });
  const known = new Set(Object.keys(environmentCatalog));
  for (const key of new Set([...Object.keys(input.definitions), ...Object.keys(input.values).filter(k => k in catalog.retired)])) {
    if (key in catalog.retired) {
      issues.push({ key, code: "retired", message: catalog.retired[key as keyof typeof catalog.retired] });
    } else if (!known.has(key) && !catalog.platformPrefixes.some(prefix => key.startsWith(prefix))) {
      issues.push({ key, code: "unknown", message: "字典未登记；确认是否拼写错误或新配置" });
    }
  }
  return {
    profile, files: input.files, rows, issues,
    duplicates: Object.entries(input.definitions).filter(([, files]) => files.length > 1)
      .map(([key, files]) => ({ key, files, different: input.conflicts.includes(key) })),
    note: "仅核对本次读取的配置与代码规则；未连接数据源、Vercel、VPS 或消息服务。",
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("npm run env:check -- [--profile=all|web|daily|flow|theta] [--file=PATH] [--strict] [--json] [--list]");
    return;
  }
  if (args.some(a => !/^(--profile=.+|--file=.+|--strict|--json|--list)$/.test(a))) throw new Error("参数无效，使用 --help 查看用法");
  const profile = args.find(a => a.startsWith("--profile="))?.slice(10) ?? "all";
  if (!environmentProfiles.includes(profile)) throw new Error("未知配置场景");
  if (args.includes("--list")) {
    for (const [key, entry] of Object.entries(environmentCatalog)) {
      console.log(`${key}\t${entry.group}\t${entry.description}`);
    }
    return;
  }
  const file = args.find(a => a.startsWith("--file="))?.slice(7);
  const input = readEnvironment({ file });
  if (file && !input.files.length) throw new Error("指定的配置文件不存在");
  const report = environmentReport(input, profile);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`环境配置检查 · ${profile} · 字典 ${Object.keys(environmentCatalog).length} 项`);
    console.log(`读取文件：${report.files.join(" → ") || "无（仅进程环境）"}`);
    const labels = { configured: "已配置", empty: "空值", default: "默认", unset: "未设置" };
    for (const row of report.rows.filter(r => r.source !== "none" && r.source !== "code" || r.required)) {
      console.log(`${row.key}\t${labels[row.status as keyof typeof labels]}\t${row.source}`);
    }
    for (const row of report.duplicates) console.log(`重复：${row.key} · ${row.different ? "值不同，按优先级取用" : "值相同"}`);
    for (const issue of report.issues) console.log(`待处理：${issue.key} · ${issue.message}`);
    console.log(`结果：${report.issues.length} 项待处理。${report.note}`);
  }
  if (args.includes("--strict") && report.issues.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch { console.error("环境配置检查未完成；请检查参数、文件是否存在以及读取权限。未输出配置内容。"); process.exitCode = 1; }
}
