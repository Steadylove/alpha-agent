import { addMonths, DAY, day, fingerprint, nextDay, quantile } from "./engineMath";
import { SEC_SCENARIO_RULE, SCENARIO_WEIGHTS, horizonSchema, scenarioAssumptionsSchema,
  type FundamentalHorizon, type FundamentalInput, type FundamentalScenarioAssumptions,
  type FundamentalValuation, type ReportedPeriod, type ReportedPeer } from "./types";

const keys = ["bear", "base", "bull"] as const;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const close = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/** Fact IDs/retrieval times are provenance, not new economic information. */
function periodFacts(period: ReportedPeriod) {
  const { sourceIds: _sourceIds, ...facts } = period;
  return facts;
}

export function reportedScenarioHash(input: FundamentalInput): string {
  const evidence = input.scenario;
  return fingerprint({ rule: SEC_SCENARIO_RULE, symbol: input.symbol, sector: input.sector, industry: input.industry,
    currency: input.currency, isEtf: input.isEtf, isAdr: input.isAdr, earningsBasis: input.earningsBasis,
    scenario: evidence ? { current: periodFacts(evidence.current), prior: periodFacts(evidence.prior),
      peers: [...evidence.peers].sort((a, b) => a.symbol.localeCompare(b.symbol)).map(peer => ({
        symbol: peer.symbol, industry: peer.industry, currency: peer.currency, current: periodFacts(peer.current),
      })) } : null });
}

function validPeriod(period: ReportedPeriod, asOf: string, requireFresh: boolean): boolean {
  const end = Date.parse(period.periodEnd), duration = (end - Date.parse(period.periodStart)) / DAY + 1;
  return duration >= 330 && duration <= 400 && period.periodEnd <= period.latestQuarterFiledAt &&
    period.latestQuarterEnd === period.periodEnd && period.latestQuarterFiledAt <= period.filedAt &&
    period.filedAt <= asOf.slice(0, 10) && (!requireFresh || Date.parse(asOf) - end <= 190 * DAY) &&
    period.sourceIds.length > 0;
}

function profitable(period: ReportedPeriod): boolean {
  return period.revenue > 0 && period.netIncome > 0 && period.operatingIncome > 0 &&
    period.operatingIncome <= period.revenue && period.netIncome <= period.operatingIncome * 1.3 &&
    period.capex >= 0 && period.operatingCashFlow - period.capex > 0 && period.latestQuarterEps > 0;
}

function validPeriodSources(period: ReportedPeriod, input: Pick<FundamentalInput, "sources" | "observedAt">): boolean {
  const sources = new Map(input.sources.map(source => [source.id, source]));
  return period.sourceIds.every(id => {
    const source = sources.get(id);
    return source && Date.parse(source.observedAt) <= Date.parse(input.observedAt) &&
      (source.publishedAt == null || (Number.isFinite(Date.parse(source.publishedAt)) &&
        Date.parse(source.publishedAt) <= Date.parse(input.observedAt)));
  });
}

/** No consensus or partially populated report is substituted for a complete reported period. */
export function validateReportedScenario(input: FundamentalInput, now: Date): string[] {
  const reasons: string[] = [], stamp = Date.parse(input.observedAt), evidence = input.scenario, f = input.financials;
  if (input.earningsBasis !== "gaap-derived-scenario") reasons.push("财报情景模型的盈利口径无效");
  if (stamp > now.getTime() || now.getTime() - stamp > DAY) reasons.push("本轮基本面证据尚未更新或采集时间无效");
  if (input.currency !== "USD" || (f && f.currency !== "USD")) reasons.push("财报情景模型仅支持交易及财务报告均为 USD 的公司");
  if (input.isAdr) reasons.push("ADR 每股换算口径尚未核实，当前模型暂不覆盖");
  if (input.isEtf || /financial|real estate/i.test(input.sector) || /bank|insurance|reit|fund/i.test(input.industry))
    reasons.push("该公司类型需要独立估值模型，当前财报情景 P/E 模型不适用");
  if (!input.industry.trim()) reasons.push("缺少可核实的行业分类");
  if (input.estimates.length || input.peers.length) reasons.push("财报情景模型不能混用一致预期或 Forward P/E 输入");
  const sources = new Map(input.sources.map(source => [source.id, source]));
  if (sources.size !== input.sources.length) reasons.push("基本面来源标识重复");
  if (input.sources.some(source => Date.parse(source.observedAt) > stamp ||
    (source.publishedAt != null && (!Number.isFinite(Date.parse(source.publishedAt)) || Date.parse(source.publishedAt) > stamp))))
    reasons.push("来源时间无效或包含尚未披露的数据");
  if (!evidence) reasons.push("缺少连续两期完整 TTM 财报，暂不能建立盈利情景");
  else {
    const { current, prior } = evidence;
    if (!validPeriod(current, input.observedAt, true) || !validPeriod(prior, input.observedAt, false) ||
      nextDay(prior.periodEnd) !== current.periodStart)
      reasons.push("TTM 期间不连续、最近季度过期或披露日期无效");
    if (!profitable(current) || !profitable(prior))
      reasons.push("连续两期盈利、自由现金流或经营性收益质量不足，暂不适用 P/E 情景估值");
    if (![current, prior].every(period => validPeriodSources(period, input))) reasons.push("财报输入缺少可核对的来源或包含未来数据");
    if (!f || f.fiscalEnd !== current.periodEnd || f.filedAt !== current.filedAt ||
      !close(f.revenue, current.revenue) || !close(f.netIncome, current.netIncome) ||
      !close(f.operatingIncome, current.operatingIncome) || !close(f.reportedEps, current.netIncome / current.dilutedShares) ||
      !close(f.freeCashFlow, current.operatingCashFlow - current.capex) || !close(f.dilutedWeightedShares, current.dilutedShares) ||
      !f.latestQuarter || f.latestQuarter.fiscalEnd !== current.latestQuarterEnd || f.latestQuarter.filedAt !== current.latestQuarterFiledAt ||
      !close(f.latestQuarter.eps, current.latestQuarterEps) || f.sourceIds.length === 0 || f.sourceIds.some(id => !sources.has(id)))
      reasons.push("财报展示口径与已披露 TTM 证据不一致");
  }
  if (input.quote && (Date.parse(input.quote.observedAt) > stamp || Date.parse(input.quote.observedAt) > now.getTime()))
    reasons.push("报价时间无效或包含未来数据");
  return [...new Set(reasons)];
}

/** Same-basis reported NI / latest diluted shares, never analyst consensus EPS. */
export function reportedPeerMultiple(peer: ReportedPeer,
  input: Pick<FundamentalInput, "symbol" | "industry" | "observedAt" | "sources">): FundamentalValuation["peers"][number] | null {
  if (peer.symbol === input.symbol || peer.currency !== "USD" ||
    peer.industry.trim().toLowerCase() !== input.industry.trim().toLowerCase() ||
    Date.parse(peer.observedAt) > Date.parse(input.observedAt) || Date.parse(input.observedAt) - Date.parse(peer.observedAt) > 7 * DAY ||
    !validPeriod(peer.current, input.observedAt, true) || !profitable(peer.current) || !validPeriodSources(peer.current, input)) return null;
  const reportedEps = peer.current.netIncome / peer.current.dilutedShares, pe = peer.price / reportedEps;
  return Number.isFinite(pe) && pe >= 2 && pe <= 100 ? { symbol: peer.symbol, reportedEps, pe } : null;
}

export function reportedPeerMultiples(input: FundamentalInput): FundamentalValuation["peers"] {
  const peers: FundamentalValuation["peers"] = [], seen = new Set<string>();
  for (const peer of input.scenario?.peers ?? []) {
    if (peer.symbol === input.symbol || seen.has(peer.symbol)) continue;
    seen.add(peer.symbol);
    const multiple = reportedPeerMultiple(peer, input);
    if (multiple) peers.push(multiple);
  }
  return peers.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function scenarioAssumptions(input: FundamentalInput): FundamentalScenarioAssumptions {
  const { current, prior } = input.scenario!;
  const observedRevenueGrowth = current.revenue / prior.revenue - 1, base = clamp(observedRevenueGrowth, -0.15, 0.20);
  const currentMargin = current.netIncome / current.revenue, baseMargin = Math.min(currentMargin, prior.netIncome / prior.revenue);
  return { revenueGrowth: { bear: clamp(base - 0.05, -0.25, 0.25), base, bull: clamp(base + 0.05, -0.25, 0.25) },
    netMargin: { bear: 0.9 * baseMargin, base: baseMargin, bull: Math.min(currentMargin, 1.1 * baseMargin) },
    dilutedShares: current.dilutedShares, baseRevenue: current.revenue, observedRevenueGrowth };
}

function scenarioHorizon(assumptions: FundamentalScenarioAssumptions, anchor: string, months: 6 | 12, multiples: number[]): FundamentalHorizon {
  const targetDate = addMonths(anchor, months);
  const [bear, base, bull] = keys.map((key, i) => {
    const annualizedRevenue = assumptions.baseRevenue * (1 + assumptions.revenueGrowth[key]) ** (months / 12);
    const eps = annualizedRevenue * assumptions.netMargin[key] / assumptions.dilutedShares;
    return { eps, multiple: multiples[i], target: eps * multiples[i], weight: SCENARIO_WEIGHTS[key] };
  });
  return { months, targetDate, earningsStart: addMonths(targetDate, -12), earningsEnd: targetDate, bear, base, bull,
    weightedTarget: bear.target * bear.weight + base.target * base.weight + bull.target * bull.weight,
    rangeLow: bear.target, rangeHigh: bull.target };
}

function computedScenario(input: FundamentalInput, anchor: string) {
  const peers = reportedPeerMultiples(input);
  if (!input.scenario || peers.length < 3) return null;
  const multiples = [0.25, 0.5, 0.75].map(p => quantile(peers.map(peer => peer.pe), p));
  const assumptions = scenarioAssumptions(input);
  return { peers, assumptions, sixMonth: scenarioHorizon(assumptions, anchor, 6, multiples),
    twelveMonth: scenarioHorizon(assumptions, anchor, 12, multiples) };
}

export function calculateReportedScenario(input: FundamentalInput, now: Date, previous?: FundamentalValuation | null,
  updateReasons?: string[]): { value: Omit<FundamentalValuation, "id"> | null; reasons: string[] } {
  const anchor = day(now), result = computedScenario(input, anchor);
  if (!result) return { value: null, reasons: ["同一行业、同币种且完整财报口径有效的同业不足 3 家"] };
  const { peers, assumptions, sixMonth, twelveMonth } = result;
  const modelChange = !!previous && previous.rule !== SEC_SCENARIO_RULE;
  let earningsContribution = 0, multipleContribution = 0;
  if (previous && !modelChange) for (const key of keys) {
    const a = previous.twelveMonth[key], b = twelveMonth[key];
    earningsContribution += b.weight * (b.eps - a.eps) * (a.multiple + b.multiple) / 2;
    multipleContribution += b.weight * (b.multiple - a.multiple) * (a.eps + b.eps) / 2;
  }
  return { value: { version: 1, rule: SEC_SCENARIO_RULE, symbol: input.symbol, publishedAt: now.toISOString(), anchorDate: anchor,
    validUntil: new Date(now.getTime() + 90 * DAY).toISOString(), inputHash: reportedScenarioHash(input), input,
    method: "Reported earnings scenario P/E", secondaryCheck: "Reported FCF / earnings quality", peers, sixMonth, twelveMonth,
    confidence: "low", assumptions: [
      "本模型为基于已披露 GAAP 财报的自建盈利情景，不是分析师一致预期，也不承诺未来成交价格。",
      "基础收入及利润采用完整 TTM；每股盈利口径为 TTM GAAP 净利润 ÷ 最新季度稀释加权股数，不等同于已报告年度每股收益。",
      "基准收入增速取已披露 TTM 同比并限制在 -15% 至 20%；悲观/乐观在此基础上减/加 5 个百分点，限制在 -25% 至 25%。",
      "基准净利率取当前与上一期 TTM 较低值；悲观为基准的 90%；乐观不高于当前净利率及基准的 110%。未来股数暂固定为最新季度稀释股数。",
      "6M / 12M EPS = 当前 TTM 收入 × (1 + 情景年增长率)^(月数/12) × 情景净利率 ÷ 最新季度稀释股数；这是目标时点年化盈利能力，不是逐季盈利预测。",
      "目标时点前 12 个月仅标识年化参考口径，不表示该区间每个季度均已获得预测或披露数据。",
      "同业 P/E 使用同口径已披露 TTM 净利润 ÷ 最新季度稀释股数；取 25% / 50% / 75% 分位数，不与 non-GAAP Forward P/E 混用。",
      "同业价格为保存的近期日线收盘价，最多容忍 7 个自然日，非实时行情；目标公司当前价格不参与目标价计算。",
      "20% / 55% / 25% 为固定情景权重，未经概率校准；区间并非未来股价的置信区间。同业相对定价也不能排除行业整体高估。",
      "正自由现金流及经营利润仅作盈利质量筛选；未核实的一次性损益不作人工扣除，尚未建模未来股本变化、季节性及业务周期拐点。",
      ...input.warnings,
    ], updateReasons: [...new Set([...(updateReasons ?? ["首次财报情景估值"]),
      ...(modelChange ? ["估值方法变更：切换盈利与倍数口径，不作同口径归因"] : [])])],
    revision: previous ? { previousId: previous.id, previousTarget: previous.twelveMonth.weightedTarget,
      newTarget: twelveMonth.weightedTarget, changePct: (twelveMonth.weightedTarget / previous.twelveMonth.weightedTarget - 1) * 100,
      earningsContribution, multipleContribution, ...(modelChange ? { kind: "model-change" as const,
        modelContribution: twelveMonth.weightedTarget - previous.twelveMonth.weightedTarget } : {}) } : null,
    analyst: null, scenarioAssumptions: assumptions,
  }, reasons: [] };
}

/** Recompute from archived evidence, including provenance gates, rather than trusting self-consistent target fields. */
export function verifyReportedScenario(value: FundamentalValuation): void {
  if (value.input.earningsBasis !== "gaap-derived-scenario" || value.method !== "Reported earnings scenario P/E" ||
    value.confidence !== "low" || value.peers.some(peer => peer.reportedEps == null || peer.ntmEps != null) ||
    validateReportedScenario(value.input, new Date(value.input.observedAt)).length ||
    value.anchorDate < value.input.observedAt.slice(0, 10) || value.anchorDate > nextDay(value.input.observedAt.slice(0, 10)))
    throw new Error("财报情景估值证据或口径校验失败");
  const expected = computedScenario(value.input, value.anchorDate);
  if (!expected || fingerprint(scenarioAssumptionsSchema.parse(value.scenarioAssumptions)) !== fingerprint(scenarioAssumptionsSchema.parse(expected.assumptions)) ||
    fingerprint(value.peers.map(peer => ({ symbol: peer.symbol, eps: peer.reportedEps, pe: peer.pe }))) !==
      fingerprint(expected.peers.map(peer => ({ symbol: peer.symbol, eps: peer.reportedEps, pe: peer.pe }))))
    throw new Error("财报情景假设或同业样本校验失败");
  for (const key of ["sixMonth", "twelveMonth"] as const) {
    if (fingerprint(horizonSchema.parse(value[key])) !== fingerprint(horizonSchema.parse(expected[key])) ||
      value[key].bear.target > value[key].base.target || value[key].base.target > value[key].bull.target)
      throw new Error("财报情景估值计算校验失败");
  }
  if (value.revision) {
    const r = value.revision, delta = r.newTarget - r.previousTarget;
    if (!close(r.newTarget, value.twelveMonth.weightedTarget) || !close(r.changePct, (r.newTarget / r.previousTarget - 1) * 100) ||
      (r.kind === "model-change" ? r.earningsContribution !== 0 || r.multipleContribution !== 0 || !close(r.modelContribution, delta) :
        r.modelContribution != null || !close(r.earningsContribution + r.multipleContribution, delta)))
      throw new Error("财报情景修订归因校验失败");
  }
}
