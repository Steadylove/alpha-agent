import "./load-env";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { calculateValuation, peerMultiples } from "@/lib/fundamental/engine";
import { createFundamentalProvider, FundamentalRateLimitError, type FundamentalProviderOptions, type FundamentalRequestObservation } from "@/lib/fundamental/providers";
import { createSecFundamentalProvider, SecFundamentalError } from "@/lib/fundamental/secProvider";
import { symbolSchema } from "@/lib/fundamental/types";
import { readFundamentalPeerDirectory } from "@/lib/fundamental/peerDirectory";
import { readSecIssuerDirectory } from "@/lib/fundamental/secIssuerDirectory";

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "ADBE", "ORCL", "CRM"];
export type FundamentalCoverageOptions = { symbols: string[] };
type CoverageTarget = {
  symbol: string; status: "ready" | "unavailable" | "failed" | "rate-limited"; checkedAt: string;
  validPeers: number; financialsAvailable: boolean; forecastFiscalEnds: string[];
  missing: string[]; warnings: string[];
};
export type FundamentalCoverageReport = {
  version: 1; provider: "sec" | "fmp"; startedAt: string; completedAt: string; readOnly: true; analysisInvoked: false;
  configured: boolean; targets: CoverageTarget[]; requests: FundamentalRequestObservation[];
  totals: { ready: number; unavailable: number; failed: number; rateLimited: number; requests: number; httpFailures: number };
};
type Dependencies = {
  now?: Date; apiKey?: string; fetchImpl?: typeof fetch;
  peerDirectory?: FundamentalProviderOptions["peerDirectory"];
  createProvider?: typeof createFundamentalProvider;
  provider?: "sec" | "fmp"; userAgent?: string; createSecProvider?: typeof createSecFundamentalProvider;
  readDirectory?: typeof readFundamentalPeerDirectory;
};

export function parseFundamentalCoverageArgs(args: string[]): FundamentalCoverageOptions {
  if (!args.length) return { symbols: [...DEFAULT_SYMBOLS] };
  if (args.length !== 1 || !args[0].startsWith("--symbol=")) throw new Error("invalid-arguments");
  const symbols = args[0].slice(9).split(",").map(value => value.trim().toUpperCase());
  if (!symbols.length || symbols.length > 10 || symbols.some(symbol => !symbolSchema.safeParse(symbol).success))
    throw new Error("invalid-symbols");
  return { symbols: [...new Set(symbols)] };
}

/** Read-only coverage inspection: no analysis calls, locks, valuation persistence or notifications. */
export async function runFundamentalCoverage(options: FundamentalCoverageOptions, dependencies: Dependencies = {}): Promise<FundamentalCoverageReport> {
  // Validate programmatic callers too, before reading directories or opening network connections.
  const { symbols } = parseFundamentalCoverageArgs([`--symbol=${options.symbols.join(",")}`]);
  const now = dependencies.now ?? new Date();
  const provider = dependencies.provider ?? (process.env.FUNDAMENTAL_PROVIDER?.trim() || "sec");
  if (provider !== "sec" && provider !== "fmp") throw new Error("invalid-fundamental-provider");
  const apiKey = dependencies.apiKey ?? process.env.FMP_API_KEY;
  const userAgent = dependencies.userAgent ?? process.env.SEC_USER_AGENT;
  const configured = Boolean((provider === "sec" ? userAgent : apiKey)?.trim());
  const requests: FundamentalRequestObservation[] = [];
  const targets: CoverageTarget[] = [];
  const common = configured ? {
    now, fetchImpl: dependencies.fetchImpl,
    peerDirectory: dependencies.peerDirectory ?? (dependencies.readDirectory ?? readFundamentalPeerDirectory)(now),
    onRequest: (observation: FundamentalRequestObservation) => requests.push(observation),
  } : null;
  const collect = common ? provider === "sec"
    ? (dependencies.createSecProvider ?? createSecFundamentalProvider)({ ...common, userAgent, issuerDirectory: readSecIssuerDirectory(now) })
    : (dependencies.createProvider ?? createFundamentalProvider)({ ...common, apiKey }) : null;
  for (const symbol of symbols) {
    const target: CoverageTarget = { symbol, status: "unavailable", checkedAt: now.toISOString(), validPeers: 0,
      financialsAvailable: false, forecastFiscalEnds: [], missing: [], warnings: [] };
    if (!collect) target.missing.push(provider === "sec" ? "SEC_USER_AGENT 未配置真实机构名和联系邮箱" : "FMP_API_KEY 未配置");
    else try {
      const input = await collect(symbol);
      if (input.symbol !== symbol) throw new Error("symbol-mismatch");
      const checked = dependencies.now ?? new Date();
      const result = calculateValuation(input, { now: checked });
      target.checkedAt = checked.toISOString();
      target.status = result.valuation ? "ready" : "unavailable";
      target.validPeers = peerMultiples(input, checked.toISOString().slice(0, 10)).length;
      target.financialsAvailable = input.financials !== null;
      target.forecastFiscalEnds = input.estimates.map(row => row.fiscalEnd);
      target.missing = result.reasons;
      target.warnings = input.warnings;
    } catch (error) {
      target.checkedAt = (dependencies.now ?? new Date()).toISOString();
      target.status = error instanceof FundamentalRateLimitError || (error instanceof SecFundamentalError && error.message.includes("429")) ? "rate-limited" : "failed";
      // Even custom providers can throw a credential-bearing URL; exception text never reaches output.
      target.missing = [error instanceof SecFundamentalError ? error.message : target.status === "rate-limited"
        ? "FMP HTTP 429 限流；本轮未完成并已停止新增请求，不能据此判断数据缺失或接口权限"
        : "采集或校验失败；查看请求状态确认接口权限与数据可用性"];
    }
    targets.push(target);
  }
  return {
    version: 1, provider, startedAt: now.toISOString(), completedAt: (dependencies.now ?? new Date()).toISOString(),
    readOnly: true, analysisInvoked: false, configured, targets, requests,
    totals: {
      ready: targets.filter(row => row.status === "ready").length,
      unavailable: targets.filter(row => row.status === "unavailable").length,
      failed: targets.filter(row => row.status === "failed").length,
      rateLimited: targets.filter(row => row.status === "rate-limited").length,
      requests: requests.length, httpFailures: requests.filter(row => row.status === "http-error").length,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve().then(() => runFundamentalCoverage(parseFundamentalCoverageArgs(process.argv.slice(2)))).then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.totals.ready !== report.targets.length) process.exitCode = 2;
  }).catch(() => {
    console.error(JSON.stringify({ status: "coverage-failed", reason: "检查参数与运行环境；诊断不会修改快照" }));
    process.exitCode = 1;
  });
}
