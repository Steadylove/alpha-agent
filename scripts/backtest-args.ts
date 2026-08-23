import { DEFAULT_BACKTEST_CONFIG, type BacktestConfig } from "@/lib/backtest/engine";

/**
 * 解析 `--key=value` 形式的回测参数覆盖，供 backtest-lab 与 search-params 共用。
 *
 * 无法识别的参数直接抛错而不是静默忽略：写错一个键名却照样跑出结果，
 * 得到的是「以为改了参数其实没改」的数字，比报错难查得多。
 */
/**
 * 由调用方自行解析、不属于 BacktestConfig 的键。
 *
 * index 决定载入哪批数据（缓存键），不是在同一批数据上重算的参数，
 * 因此不进 config；但仍要在这里登记，否则会被当成写错的键名抛掉。
 */
const NON_CONFIG_KEYS = new Set(["index"]);

export function parseArgs(argv = process.argv.slice(2)): Partial<BacktestConfig> {
  const out: Record<string, unknown> = {};

  for (const arg of argv) {
    if (arg.startsWith("--") && !arg.includes("=")) continue; // --sweep / --stability 这类开关

    const m = /^--(\w+)=(.+)$/.exec(arg);
    if (!m) throw new Error(`无法解析的参数: ${arg}`);

    const [, key, raw] = m;
    if (NON_CONFIG_KEYS.has(key)) continue;
    if (!(key in DEFAULT_BACKTEST_CONFIG)) {
      throw new Error(`未知参数 ${key}，可用: ${Object.keys(DEFAULT_BACKTEST_CONFIG).join(", ")}`);
    }

    if (raw === "null") out[key] = null;
    else if (raw === "true" || raw === "false") out[key] = raw === "true";
    // 允许 30e6 这种写法：成交额门槛是八位数，逐个数零容易错
    else out[key] = /^-?[\d.]+(e-?\d+)?$/i.test(raw) ? Number(raw) : raw;
  }

  return out as Partial<BacktestConfig>;
}
