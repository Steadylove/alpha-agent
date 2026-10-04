import { createHash } from "node:crypto";
import { FUNDAMENTAL_RULE, SCENARIO_WEIGHTS, inputSchema, valuationSchema, type AnnualEstimate,
  type FundamentalHorizon, type FundamentalInput, type FundamentalValuation } from "./types";

const DAY = 86_400_000;
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const day = (date: Date) => date.toISOString().slice(0, 10);
const nextDay = (date: string) => day(new Date(Date.parse(date) + DAY));

/** Calendar months, clamped to the last day rather than overflowing into the next month. */
export function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`), original = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(original, last));
  return day(d);
}

/** Prorate annual non-GAAP consensus over [start, start + 12 calendar months).
 * No missing fiscal year is extrapolated and no current quote enters the earnings estimate. */
export function forwardEps(estimates: AnnualEstimate[], start: string, scenario: "epsLow" | "epsAvg" | "epsHigh" = "epsAvg"): number | null {
  const end = addMonths(start, 12), rows = [...estimates].sort((a, b) => a.fiscalEnd.localeCompare(b.fiscalEnd));
  if (new Set(rows.map(row => row.fiscalEnd)).size !== rows.length) return null;
  let coveredUntil = start, total = 0;
  for (let i = 0; i < rows.length && coveredUntil < end; i++) {
    const row = rows[i], from = i ? nextDay(rows[i - 1].fiscalEnd) : nextDay(addMonths(row.fiscalEnd, -12));
    const to = nextDay(row.fiscalEnd), duration = (Date.parse(to) - Date.parse(from)) / DAY;
    if (to <= start || from >= end) continue;
    if (duration < 330 || duration > 400 || from > coveredUntil || row.analystCount < 3) return null;
    const value = row[scenario];
    if (value == null || value <= 0) return null;
    const overlapEnd = to < end ? to : end;
    total += value * (Date.parse(overlapEnd) - Date.parse(coveredUntil)) / DAY / duration;
    coveredUntil = overlapEnd;
  }
  return coveredUntil === end && Number.isFinite(total) && total > 0 ? total : null;
}

const quantile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * p, low = Math.floor(pos);
  return sorted[low] + (sorted[Math.ceil(pos)] - sorted[low]) * (pos - low);
};

export function peerMultiples(input: FundamentalInput, anchorDate: string) {
  const peers: FundamentalValuation["peers"] = [];
  const seen = new Set<string>();
  for (const peer of input.peers) {
    if (peer.symbol === input.symbol || seen.has(peer.symbol) || peer.currency !== "USD" ||
      peer.industry.trim().toLowerCase() !== input.industry.trim().toLowerCase() ||
      Date.parse(peer.observedAt) > Date.parse(input.observedAt) ||
      Date.parse(input.observedAt) - Date.parse(peer.observedAt) > DAY) continue;
    seen.add(peer.symbol);
    const eps = forwardEps(peer.estimates, anchorDate), pe = eps == null ? null : peer.price / eps;
    // An extreme/negative multiple requires another model, not clipping into the supported range.
    if (eps == null || pe == null || pe < 2 || pe > 100) continue;
    peers.push({ symbol: peer.symbol, ntmEps: eps, pe });
  }
  return peers.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Ignore retrieval timestamps and quote movement. Earnings/membership changes remain material. */
export function fundamentalHash(input: FundamentalInput): string {
  const estimates = input.estimates.map(({ sourceId: _source, ...row }) => row).sort((a, b) => a.fiscalEnd.localeCompare(b.fiscalEnd));
  const financials = input.financials ? { ...input.financials, sourceIds: undefined } : null;
  return fingerprint({ rule: FUNDAMENTAL_RULE, symbol: input.symbol, sector: input.sector, industry: input.industry,
    currency: input.currency, isEtf: input.isEtf, isAdr: input.isAdr, earningsBasis: input.earningsBasis, financials, estimates });
}

export function validateInput(raw: FundamentalInput, now = new Date()): { input: FundamentalInput; reasons: string[] } {
  const input = inputSchema.parse(raw), reasons: string[] = [];
  const stamp = Date.parse(input.observedAt), today = day(now), f = input.financials;
  if (stamp > now.getTime() || now.getTime() - stamp > DAY) reasons.push("本轮基本面证据尚未更新或采集时间无效");
  if (input.currency !== "USD" || f?.currency !== "USD") reasons.push("V1 仅支持交易及财务报告均为 USD 的公司");
  if (input.isAdr) reasons.push("ADR 每股换算口径尚未核实，当前模型暂不覆盖");
  if (input.isEtf || /financial|real estate/i.test(input.sector) || /bank|insurance|reit/i.test(input.industry))
    reasons.push("该公司类型需要独立估值模型，当前 Forward P/E 模型不适用");
  if (!input.industry.trim()) reasons.push("缺少可核实的行业分类");
  const sources = new Map(input.sources.map(source => [source.id, source]));
  if (sources.size !== input.sources.length) reasons.push("基本面来源标识重复");
  const sourceIds = [...input.estimates.map(row => row.sourceId), ...(f?.sourceIds ?? []), ...input.peers.flatMap(peer => [...peer.sourceIds, ...peer.estimates.map(row => row.sourceId)])];
  if (sourceIds.some(id => !sources.has(id))) reasons.push("部分估值输入缺少对应来源");
  if (input.sources.some(source => Date.parse(source.observedAt) > stamp ||
    (source.publishedAt != null && (!Number.isFinite(Date.parse(source.publishedAt)) || Date.parse(source.publishedAt) > stamp))))
    reasons.push("来源时间无效或包含尚未披露的数据");
  if (!f) reasons.push("缺少已披露的财务报表");
  else {
    if (f.filedAt > today || f.fiscalEnd > f.filedAt || now.getTime() - Date.parse(f.fiscalEnd) > 460 * DAY)
      reasons.push("年度财报过期或披露时间无效");
    if (f.reportedEps == null || f.reportedEps <= 0 || f.netIncome == null || f.netIncome <= 0 ||
      f.operatingIncome == null || f.operatingIncome <= 0 || f.revenue == null || f.revenue <= 0)
      reasons.push("缺少可验证的正盈利记录，暂不使用 P/E 估值");
    if (f.freeCashFlow == null || f.freeCashFlow <= 0) reasons.push("自由现金流未能确认盈利质量，需其他模型复核");
    if (f.netIncome != null && f.operatingIncome != null && f.netIncome > f.operatingIncome * 1.3)
      reasons.push("非经营性收益可能显著影响盈利，需核实 Normalized Earnings 后再估值");
    if (!f.latestQuarter || f.latestQuarter.filedAt > today || f.latestQuarter.fiscalEnd > f.latestQuarter.filedAt ||
      now.getTime() - Date.parse(f.latestQuarter.fiscalEnd) > 190 * DAY || f.latestQuarter.eps == null || f.latestQuarter.eps <= 0)
      reasons.push("最近季度的有效正盈利记录不足");
  }
  if (input.estimates.some(row => row.epsLow != null && row.epsAvg != null && row.epsHigh != null &&
    (row.epsLow > row.epsAvg || row.epsAvg > row.epsHigh))) reasons.push("盈利预测区间顺序异常");
  return { input, reasons };
}

function horizon(input: FundamentalInput, anchor: string, months: 6 | 12, multiples: number[]): FundamentalHorizon | null {
  const targetDate = addMonths(anchor, months), end = addMonths(targetDate, 12);
  const values = ["epsLow", "epsAvg", "epsHigh"].map(key => forwardEps(input.estimates, targetDate, key as "epsLow" | "epsAvg" | "epsHigh"));
  if (values.some(value => value == null)) return null;
  const [bear, base, bull] = (["bear", "base", "bull"] as const).map((key, i) => ({
    eps: values[i]!, multiple: multiples[i], target: values[i]! * multiples[i], weight: SCENARIO_WEIGHTS[key],
  }));
  if (bear.target > base.target || base.target > bull.target) return null;
  return { months, targetDate, earningsStart: targetDate, earningsEnd: end, bear, base, bull,
    weightedTarget: bear.target * bear.weight + base.target * base.weight + bull.target * bull.weight,
    rangeLow: bear.target, rangeHigh: bull.target };
}

export function valuationId(value: Omit<FundamentalValuation, "id"> | FundamentalValuation): string {
  // Zod reconstructs object keys in schema order; use that same order before and after persistence.
  const { id: _id, ...withoutId } = { ...value, id: undefined };
  return fingerprint(valuationSchema.omit({ id: true }).parse({ ...withoutId, analyst: null }));
}

export function calculateValuation(raw: FundamentalInput, options: {
  now?: Date; previous?: FundamentalValuation | null; updateReasons?: string[];
} = {}): { valuation: FundamentalValuation | null; reasons: string[] } {
  const now = options.now ?? new Date(), { input, reasons } = validateInput(raw, now), anchor = day(now);
  const peers = peerMultiples(input, anchor);
  if (peers.length < 3) reasons.push("同一行业、同币种且预测覆盖有效的同业不足 3 家");
  const multiples = [0.25, 0.5, 0.75].map(p => peers.length ? quantile(peers.map(row => row.pe), p) : 0);
  const sixMonth = horizon(input, anchor, 6, multiples), twelveMonth = horizon(input, anchor, 12, multiples);
  if (!sixMonth || !twelveMonth) reasons.push("6M / 12M 所需完整财年预测或至少 3 名分析师覆盖不足");
  if (reasons.length || !sixMonth || !twelveMonth) return { valuation: null, reasons: [...new Set(reasons)] };
  const previous = options.previous;
  let earningsContribution = 0, multipleContribution = 0;
  if (previous) for (const key of ["bear", "base", "bull"] as const) {
    const a = previous.twelveMonth[key], b = twelveMonth[key];
    earningsContribution += b.weight * (b.eps - a.eps) * (a.multiple + b.multiple) / 2;
    multipleContribution += b.weight * (b.multiple - a.multiple) * (a.eps + b.eps) / 2;
  }
  const value: Omit<FundamentalValuation, "id"> = {
    version: 1, rule: FUNDAMENTAL_RULE, symbol: input.symbol, publishedAt: now.toISOString(), anchorDate: anchor,
    validUntil: new Date(now.getTime() + 90 * DAY).toISOString(), inputHash: fundamentalHash(input), input,
    method: "Forward P/E", secondaryCheck: "Reported FCF / earnings quality", peers, sixMonth, twelveMonth,
    confidence: "low", updateReasons: options.updateReasons ?? ["首次基本面估值"],
    assumptions: [
      "6M / 12M 为从估值基准日起的固定目标日期；各自使用目标日期之后 12 个月的盈利预测。",
      "盈利按年度 non-GAAP 一致预期及财年覆盖天数摊分，未建模季节性；GAAP 财报 EPS 不与预测 EPS 混用。",
      "同业当前 NTM Forward P/E 的 25% / 50% / 75% 分位数作为情景倍数，并非完整行业样本或独立内在价值结论。",
      "20% / 55% / 25% 为固定情景权重，未经概率校准；区间是估值情景区间，不是未来交易价格的置信区间。",
      "自由现金流仅用于已披露盈利质量核对，并非第二套现金流目标价模型；未确认事项不作 EPS 人工调整。",
      ...input.warnings,
    ],
    revision: previous ? { previousId: previous.id, previousTarget: previous.twelveMonth.weightedTarget,
      newTarget: twelveMonth.weightedTarget, changePct: (twelveMonth.weightedTarget / previous.twelveMonth.weightedTarget - 1) * 100,
      earningsContribution, multipleContribution } : null,
    analyst: null,
  };
  return { valuation: valuationSchema.parse({ ...value, id: valuationId(value) }), reasons: [] };
}

/** Verify persisted math and identity before exposing targets on the website. */
export function parseValuation(raw: unknown): FundamentalValuation {
  const value = valuationSchema.parse(raw);
  if (value.id !== valuationId(value) || value.symbol !== value.input.symbol || value.inputHash !== fundamentalHash(value.input))
    throw new Error("估值版本校验失败");
  if (Date.parse(value.publishedAt) < Date.parse(value.input.observedAt) ||
    Date.parse(value.validUntil) <= Date.parse(value.publishedAt) || value.anchorDate > value.publishedAt.slice(0, 10))
    throw new Error("估值发布时间校验失败");
  for (const [h, months] of [[value.sixMonth, 6], [value.twelveMonth, 12]] as const) {
    let weighted = 0;
    for (const key of ["bear", "base", "bull"] as const) {
      const s = h[key];
      if (s.weight !== SCENARIO_WEIGHTS[key] || Math.abs(s.eps * s.multiple - s.target) > 1e-6) throw new Error("估值计算校验失败");
      weighted += s.target * s.weight;
    }
    if (h.months !== months || h.targetDate !== addMonths(value.anchorDate, months) || h.earningsStart !== h.targetDate ||
      h.earningsEnd !== addMonths(h.targetDate, 12) || Math.abs(weighted - h.weightedTarget) > 1e-6 ||
      h.rangeLow !== h.bear.target || h.rangeHigh !== h.bull.target || h.bear.target > h.base.target || h.base.target > h.bull.target)
      throw new Error("估值区间校验失败");
  }
  return value;
}

export function updateReasons(previous: FundamentalValuation | null, input: FundamentalInput, now: Date, newEvents: string[] = []): string[] {
  if (!previous) return ["首次基本面估值"];
  const reasons: string[] = [];
  if (previous.rule !== FUNDAMENTAL_RULE) reasons.push("估值规则版本更新");
  if (fundamentalHash(input) !== previous.inputHash) reasons.push("财报或盈利预测输入更新");
  const peers = peerMultiples(input, day(now));
  if (peers.map(row => row.symbol).join() !== previous.peers.map(row => row.symbol).join()) reasons.push("有效同业样本变化，需重新复核");
  else if (peers.length >= 3) {
    const oldMedian = quantile(previous.peers.map(row => row.pe), 0.5), current = quantile(peers.map(row => row.pe), 0.5);
    if (Math.abs(current / oldMedian - 1) >= 0.15) reasons.push("同一同业样本 Forward P/E 中位数变化达到 15%");
  }
  if (Date.parse(previous.validUntil) <= now.getTime()) reasons.push("90 天有效期复核，预测窗口向前滚动");
  if (newEvents.length) reasons.push("发现新的重大公司事件，估值需人工复核");
  return reasons;
}
