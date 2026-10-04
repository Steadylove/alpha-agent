import { calculateValuation, updateReasons, validateInput, valuationId } from "./engine";
import { FundamentalRateLimitError } from "./providers";
import { SecFundamentalError } from "./secProvider";
import { readFundamentalState, saveFundamentalState } from "./store";
import type { FundamentalAnalyst, FundamentalInput, FundamentalState, FundamentalValuation } from "./types";

type Dependencies = {
  collect: (symbol: string) => Promise<FundamentalInput>;
  read: typeof readFundamentalState;
  save: typeof saveFundamentalState;
  analyze?: (valuation: FundamentalValuation) => Promise<FundamentalAnalyst>;
};

/** Isolated, idempotent writer; failures never reach strategy/account/delivery code. */
export async function refreshFundamentalSymbol(symbol: string, options: {
  now?: Date; force?: boolean; eventIds?: string[]; reviewedEventIds?: string[]; coverageWarnings?: string[];
}, overrides: Pick<Dependencies, "collect"> & Partial<Dependencies>): Promise<{ status: "cached" | "updated"; state: FundamentalState }> {
  const now = options.now ?? new Date(), deps = { read: readFundamentalState, save: saveFundamentalState, ...overrides };
  const previous = deps.read(symbol), timestamp = now.toISOString();
  const events = [...new Set([...(previous?.eventIds ?? []), ...(options.eventIds ?? [])])].filter(id => !options.reviewedEventIds?.includes(id));
  if (previous && Date.parse(previous.checkedAt) > now.getTime()) throw new Error("不能用较早采集覆盖较新的估值");
  if (!options.force && previous && Date.parse(previous.nextCheckAt) > now.getTime() &&
    events.join() === previous.eventIds.join() && !(options.reviewedEventIds?.length)) return { status: "cached", state: previous };
  let state: FundamentalState = {
    version: 1, symbol, checkedAt: timestamp, nextCheckAt: new Date(now.getTime() + 24 * 3600000).toISOString(),
    status: previous?.current ? "stale" : "unavailable", current: previous?.current ?? null,
    latestQuote: previous?.latestQuote ?? null, reasons: [], eventIds: events.slice(-200),
    analystStatus: previous?.analystStatus ?? "not-requested",
  };
  let sourceWarnings: string[] = [];
  try {
    const input = await deps.collect(symbol);
    if (input.symbol !== symbol) throw new Error("wrong symbol");
    state.latestQuote = input.quote;
    // Evidence collected during this call can be newer than the job's start clock.
    // Validate at completion, while retaining the explicit clock used by deterministic callers.
    const assessedAt = options.now ?? new Date();
    const validity = validateInput(input, assessedAt);
    sourceWarnings = validity.input.warnings;
    if (validity.reasons.length) state.reasons = validity.reasons;
    else if (events.length) {
      state.reasons = ["重大事件可能影响财务假设，需复核后发布新估值", ...events.map(id => `待复核事件：${id}`)];
    } else {
      const reasons = updateReasons(previous?.current ?? null, input, assessedAt);
      if (previous?.status === "stale" && options.reviewedEventIds?.length) reasons.push("重大事件已完成显式复核");
      // Check all current inputs even on a cache hit: disappearing forecasts/peers cannot remain current.
      const computed = calculateValuation(input, { now: assessedAt, previous: previous?.current, updateReasons: reasons });
      if (!computed.valuation) state.reasons = computed.reasons;
      else if (!reasons.length && previous?.current) {
        state = { ...state, status: "ready", current: previous.current, reasons: [] };
        // Retry missing explanations on the same daily cadence; keep every numerical assumption
        // and the original expiry. Publishing an explanation never overwrites the old edition.
        if (deps.analyze && !previous.current.analyst) {
          const supplemented = { ...previous.current, analyst: null,
            updateReasons: ["补充 AI 解读，估值假设与目标价未变"],
            revision: { previousId: previous.current.id, previousTarget: previous.current.twelveMonth.weightedTarget,
              newTarget: previous.current.twelveMonth.weightedTarget, changePct: 0, earningsContribution: 0, multipleContribution: 0 } };
          try {
            const analyst = await deps.analyze(supplemented);
            const enriched = { ...supplemented, analyst, publishedAt: (options.now ?? new Date()).toISOString() };
            enriched.id = valuationId(enriched);
            state = { ...state, current: enriched, analystStatus: "ready" };
          } catch { state.analystStatus = "unavailable"; }
        }
      } else {
        const valuation = computed.valuation;
        let analystStatus: FundamentalState["analystStatus"] = "not-requested";
        if (deps.analyze) {
          try { valuation.analyst = await deps.analyze(valuation); analystStatus = "ready"; }
          catch { analystStatus = "unavailable"; }
        }
        // Publication means the result is actually ready, not when a slow provider/LLM call began.
        const published = options.now ?? new Date();
        valuation.publishedAt = published.toISOString();
        valuation.validUntil = new Date(published.getTime() + 90 * 86400000).toISOString();
        valuation.id = valuationId(valuation);
        state = { ...state, status: "ready", current: valuation, reasons: [], analystStatus };
      }
    }
  } catch (error) {
    state.reasons = [error instanceof SecFundamentalError ? error.message : error instanceof FundamentalRateLimitError
      ? "数据源限流（HTTP 429），本轮采集未完成；没有生成新目标价，待下次复核重试"
      : "本轮财务数据采集或校验失败；没有使用缺失数据生成新目标价"];
    state.nextCheckAt = new Date(now.getTime() + 6 * 3600000).toISOString();
  }
  state.checkedAt = (options.now ?? new Date()).toISOString();
  // Failed first collections have no archived input; retain vendor coverage diagnostics here.
  state.reasons = [...new Set([...state.reasons, ...(state.status === "ready" ? [] : sourceWarnings), ...(options.coverageWarnings ?? [])])];
  deps.save(state);
  return { status: "updated", state };
}
