import { DEFAULT_BACKTEST_CONFIG, type BacktestConfig } from "@/lib/backtest/engine";

/**
 * 解析 `--key=value` 形式的回测参数覆盖，供 backtest-lab 与 search-params 共用。
 *
 * 无法识别的参数直接抛错而不是静默忽略：写错一个键名却照样跑出结果，
 * 得到的是「以为改了参数其实没改」的数字，比报错难查得多。
 */
export function parseArgs(argv = process.argv.slice(2)): Partial<BacktestConfig> {
  const out: Record<string, unknown> = {};

  for (const arg of argv) {
    if (arg.startsWith("--") && !arg.includes("=")) continue; // --sweep / --stability 这类开关

    const m = /^--(\w+)=(.+)$/.exec(arg);
    if (!m) throw new Error(`无法解析的参数: ${arg}`);

    const [, key, raw] = m;
    if (!(key in DEFAULT_BACKTEST_CONFIG)) {
      throw new Error(`未知参数 ${key}，可用: ${Object.keys(DEFAULT_BACKTEST_CONFIG).join(", ")}`);
    }

    if (raw === "null") out[key] = null;
    else if (raw === "true" || raw === "false") out[key] = raw === "true";
    else out[key] = /^-?[\d.]+$/.test(raw) ? Number(raw) : raw;
  }

  return out as Partial<BacktestConfig>;
}
