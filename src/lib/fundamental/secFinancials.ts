import type { ReportedPeriod } from "./types";

type Json = Record<string, unknown>;
export type SecFact = { start: string; end: string; val: number; filed: string; accn: string; form: string };
type Fact = SecFact;
export class SecFinancialDataUnavailable extends Error {}
const DataUnavailable = SecFinancialDataUnavailable;
const DAY = 86_400_000;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const day = (value: unknown): string | null => {
  const text = string(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text)) && new Date(text).toISOString().slice(0, 10) === text ? text : null;
};
const distance = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const nextDay = (date: string) => new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);
const duration = (fact: Fact) => distance(fact.start, fact.end) + 1;
const annual = (fact: Fact) => duration(fact) >= 350 && duration(fact) <= 380;
const quarter = (fact: Fact) => duration(fact) >= 70 && duration(fact) <= 105;
const accession = /^\d{10}-\d{2}-\d{6}$/;
const revenueTags = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"];
const tags = { netIncome: "NetIncomeLoss", operatingIncome: "OperatingIncomeLoss", operatingCashFlow: "NetCashProvidedByUsedInOperatingActivities", capex: "PaymentsToAcquirePropertyPlantAndEquipment" } as const;
const sharesTag = "WeightedAverageNumberOfDilutedSharesOutstanding";


function factsFor(raw: Json, tag: string, unit: string, today: string): Fact[] {
  const values = object(object(object(raw.facts)["us-gaap"])[tag]).units;
  const rows = object(values)[unit];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(value => {
    const row = object(value), start = day(row.start), end = day(row.end), filed = day(row.filed), accn = string(row.accn), form = string(row.form);
    if (!start || !end || !filed || start > end || end > today || filed >= today || filed < end || !accession.test(accn) ||
      !/^10-[KQ](\/A)?$/.test(form) || typeof row.val !== "number" || !Number.isFinite(row.val)) return [];
    return [{ start, end, filed, accn, form, val: row.val }];
  });
}
const latest = (rows: Fact[]) => rows.sort((a, b) => b.filed.localeCompare(a.filed) || b.accn.localeCompare(a.accn))[0];
type Component = { start: string; end: string; sign: 1 | -1 };
function components(ni: Fact[], end: string): Component[] | null {
  // A twelve-month cash-flow comparison in a 10-Q is not a fiscal-year anchor.
  const years = ni.filter(row => annual(row) && /^10-K/.test(row.form));
  const year = latest(years.filter(row => row.end === end));
  if (year) return [{ start: year.start, end, sign: 1 }];
  const priorYear = years.filter(row => row.end < end).sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0];
  if (!priorYear) return null;
  const ytd = latest(ni.filter(row => row.start === nextDay(priorYear.end) && row.end === end));
  const priorYtd = latest(ni.filter(row => row.start === priorYear.start && Math.abs(distance(row.end, end) - 365) <= 14 && ytd && Math.abs(duration(row) - duration(ytd)) <= 14));
  return ytd && priorYtd ? [{ start: priorYear.start, end: priorYear.end, sign: 1 }, { start: ytd.start, end, sign: 1 }, { start: priorYtd.start, end: priorYtd.end, sign: -1 }] : null;
}

export function normalizeSecPeriods(raw: Json, cik: string, today: string): { current: ReportedPeriod; prior: ReportedPeriod; evidence: Fact[]; warnings: string[] } {
  const warnings: string[] = [];
  const usd = (tag: string) => factsFor(raw, tag, "USD", today);
  const subtract = (left: Fact[], right: Fact[]) => left.flatMap(a => {
    const b = right.find(row => row.start === a.start && row.end === a.end && row.accn === a.accn);
    return b ? [{ ...a, val: a.val - b.val }] : [];
  });
  const equivalent = (direct: Fact[], derived: Fact[]) => {
    const extra = derived.filter(row => !direct.some(other => other.start === row.start && other.end === row.end && other.accn === row.accn));
    return [...direct, ...extra];
  };
  const directNi = usd(tags.netIncome);
  const derivedNi = subtract(usd("ProfitLoss"), usd("NetIncomeLossAttributableToNoncontrollingInterest"));
  const ni = equivalent(directNi, derivedNi), shares = factsFor(raw, sharesTag, "shares", today);
  if (!ni.length) throw new DataUnavailable("缺少已披露 USD NetIncomeLoss，或申报日期尚不可用");
  const latestEnd = ni.map(row => row.end).sort().at(-1)!;
  const currentParts = components(ni, latestEnd);
  if (!currentParts) throw new DataUnavailable("最新期间无法组成完整 TTM（年度及两期累计值缺失）");
  const currentStart = currentParts.length === 1 ? currentParts[0].start : nextDay(currentParts[2].end);
  const priorEnd = new Date(Date.parse(currentStart) - DAY).toISOString().slice(0, 10);
  const priorParts = components(ni, priorEnd);
  if (!priorParts) throw new DataUnavailable("缺少与当前 TTM 连续可比的上年 TTM");
  const allParts = [...currentParts, ...priorParts];
  const complete = (rows: Fact[]) => allParts.every(part => rows.some(row => row.start === part.start && row.end === part.end));
  // A complete reported series is authoritative; an unused identity may differ
  // because the filing rounded each disclosed amount independently.
  for (const row of (complete(directNi) ? [] : derivedNi).filter(value => allParts.some(part => value.start === part.start && value.end === part.end))) {
    const direct = directNi.find(value => value.start === row.start && value.end === row.end && value.accn === row.accn);
    if (direct && direct.val !== row.val) throw new DataUnavailable("直接净利与同申报归属母公司收益恒等式不一致，口径待核实");
  }
  const revenueTag = revenueTags.find(tag => {
    const values = factsFor(raw, tag, "USD", today);
    return allParts.every(part => values.some(row => row.start === part.start && row.end === part.end));
  });
  if (!revenueTag) throw new DataUnavailable("缺少同一 USD 营收标签的完整当前及上年期间");
  const capexTag = [tags.capex, "PaymentsToAcquireProductiveAssets"].find(tag => complete(usd(tag)));
  if (!capexTag) throw new DataUnavailable("缺少同一资本性现金支出标签的完整当前及上年期间，不能拼接 PP&E 与较宽生产性资产口径");
  if (capexTag !== tags.capex) warnings.push("资本支出采用 SEC PaymentsToAcquireProductiveAssets（PP&E、软件及其他无形资产资本性现金支出），FCF=经营现金流−该较宽口径支出；不是纯 PP&E。");
  if (revenueTag.endsWith("IncludingAssessedTax")) warnings.push("营收采用完整可比的 SEC RevenueFromContractWithCustomerIncludingAssessedTax 报告口径，可能含代征税款。");
  if (!complete(directNi)) warnings.push("净利缺失期间由同一申报的 ProfitLoss−NetIncomeLossAttributableToNoncontrollingInterest 推导，未将含少数股东收益直接作为每股分子。");
  const directOi = usd(tags.operatingIncome);
  const oiCandidates = [directOi, subtract(usd("GrossProfit"), usd("OperatingExpenses")), subtract(usd("IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"), usd("NonoperatingIncomeExpense"))];
  const oiIndex = oiCandidates.findIndex((rows, index) => complete(rows) && (index === 0 || rows.every(row => {
    const direct = directOi.find(value => value.start === row.start && value.end === row.end && value.accn === row.accn);
    if (!direct) return true;
    return direct.val === row.val;
  })));
  if (oiIndex < 0) throw new DataUnavailable("缺少完整营业利润或可核对的同申报营业利润恒等式，无法组成 TTM");
  if (oiIndex > 0) warnings.push(oiIndex === 1 ? "营业利润由同一申报的 GrossProfit−OperatingExpenses 推导。" : "营业利润由同一申报的税前持续经营收益−NonoperatingIncomeExpense（非经营收益/费用总额）推导。");
  const series = { revenue: usd(revenueTag), netIncome: ni, operatingIncome: oiCandidates[oiIndex], operatingCashFlow: usd(tags.operatingCashFlow), capex: usd(capexTag) };
  const evidence: Fact[] = [];
  const sourceId = (row: Fact) => `sec:${cik}:${row.accn}`;
  function requireLatestValue(selected: Fact, rows: Fact[]) {
    const newest = latest(rows.filter(row => row.start === selected.start && row.end === selected.end));
    if (newest && newest.val !== selected.val) throw new DataUnavailable("单季净利或稀释股数存在较新重述，共同申报版本口径待核实");
  }
  function alignedQuarter(end: string): { income: Fact; shares: number; filed: string; sources: Fact[] } {
    const candidates = ni.filter(row => row.end === end && quarter(row)).sort((a, b) => b.filed.localeCompare(a.filed));
    for (const income of candidates) {
      const weighted = latest(shares.filter(row => row.start === income.start && row.end === end && row.accn === income.accn && row.val > 0));
      if (weighted) {
        requireLatestValue(income, ni);
        requireLatestValue(weighted, shares);
        return { income, shares: weighted.val, filed: income.filed, sources: [income, weighted] };
      }
    }
    // Net income is additive, but diluted weighted shares are not: annual/9M
    // dilution can use different average prices and anti-dilution decisions.
    // Derive only Q4 income, and only when its shares are directly reported in
    // the same annual filing. Never infer quarter shares from weighted averages.
    for (const year of ni.filter(row => row.end === end && annual(row) && /^10-K/.test(row.form)).sort((a, b) => b.filed.localeCompare(a.filed))) {
      const reportedShares = latest(shares.filter(row => row.end === end && quarter(row) && row.accn === year.accn && row.val > 0));
      if (!reportedShares) continue;
      const nine = latest(ni.filter(row => row.start === year.start && nextDay(row.end) === reportedShares.start && duration(row) >= 250 && duration(row) <= 290));
      if (!nine) continue;
      requireLatestValue(year, ni);
      requireLatestValue(nine, ni);
      requireLatestValue(reportedShares, shares);
      if (year.accn !== nine.accn && [year, nine].some(selected => ni.some(row => row.start === selected.start && row.end === selected.end && row.val !== selected.val))) {
        throw new DataUnavailable("全年或九个月净利曾被重述，跨申报 Q4 净利口径待核实");
      }
      const income = { ...year, start: nextDay(nine.end), val: year.val - nine.val };
      requireLatestValue(income, ni);
      warnings.push(`截至 ${end} 的 Q4 净利由全年减九个月推导；稀释股数采用年报直接披露的 Q4 值，未对加权股数做减法或时间反推。`);
      return { income, shares: reportedShares.val, filed: [year.filed, nine.filed].sort().at(-1)!, sources: [year, nine, reportedShares] };
    }
    throw new DataUnavailable("缺少最新单季净利及同口径稀释加权股数（Q4 不以全年 EPS 冒充）");
  }
  function build(parts: Component[]): ReportedPeriod {
    const end = parts.length === 1 ? parts[0].end : parts[1].end;
    const values = { revenue: 0, netIncome: 0, operatingIncome: 0, operatingCashFlow: 0, capex: 0 };
    const used: Fact[] = [];
    for (const part of parts) {
      const matching = Object.entries(series).map(([key, rows]) => ({ key: key as keyof typeof values, rows: rows.filter(row => row.start === part.start && row.end === part.end) }));
      if (matching.some(item => !item.rows.length)) throw new DataUnavailable("缺少完整营业利润、经营现金流或同口径资本性现金支出，无法组成 TTM");
      // All amounts for a component must originate in one filing; do not silently
      // mix revisions of income and cash flow statements.
      const common = matching[0].rows.filter(row => matching.every(item => item.rows.some(other => other.accn === row.accn)));
      const chosen = latest(common);
      if (!chosen) throw new DataUnavailable("财报组件没有共同申报版本，修订口径无法确认");
      for (const item of matching) {
        const row = item.rows.find(candidate => candidate.accn === chosen.accn)!;
        if (latest([...item.rows]).val !== row.val) throw new DataUnavailable("较新申报重述与共同财报版本不一致，无法确认 TTM 口径");
        if (item.key === "capex" && row.val < 0) throw new DataUnavailable("资本支出符号异常");
        values[item.key] += row.val * part.sign;
        used.push(row);
      }
    }
    const q = alignedQuarter(end);
    if (values.capex < 0) throw new DataUnavailable("组合后的 TTM 资本支出为负，报告口径待核实");
    const earningsPeriods = [...parts, { start: q.income.start, end: q.income.end }];
    for (const period of earningsPeriods) {
      const income = latest(ni.filter(row => row.start === period.start && row.end === period.end));
      const commonIncome = latest(factsFor(raw, "NetIncomeLossAvailableToCommonStockholdersBasic", "USD", today).filter(row => row.start === period.start && row.end === period.end));
      if (income && commonIncome && Math.abs(income.val - commonIncome.val) > Math.max(1, Math.abs(income.val) * 0.001)) throw new DataUnavailable("净利与普通股可用收益存在差异，普通股每股收益口径待核实");
      for (const tag of ["PreferredStockDividendsAndOtherAdjustments", "PreferredStockDividends"]) {
        const adjustment = latest(factsFor(raw, tag, "USD", today).filter(row => row.start === period.start && row.end === period.end));
        if (adjustment && adjustment.val !== 0) throw new DataUnavailable("存在优先股股息或调整，普通股每股收益口径待核实");
      }
    }
    let previousQuarter = shares.filter(row => quarter(row) && row.end < end && distance(row.end, end) >= 70 && distance(row.end, end) <= 105)
      .sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0];
    if (!previousQuarter) {
      const previousEnd = ni.filter(row => /^10-K/.test(row.form) && annual(row) && row.end < end && distance(row.end, end) >= 70 && distance(row.end, end) <= 105).map(row => row.end).sort().at(-1);
      if (previousEnd) {
        const previous = alignedQuarter(previousEnd);
        previousQuarter = { ...previous.income, val: previous.shares, filed: previous.filed };
        used.push(...previous.sources);
      }
    }
    if (!previousQuarter || previousQuarter.val <= 0 || Math.abs(q.shares / previousQuarter.val - 1) > 0.2) throw new DataUnavailable("相邻季度稀释股数缺失或变动超过 20%，需核实拆股及每股口径");
    used.push(...q.sources, previousQuarter);
    evidence.push(...used);
    return { periodStart: parts.length === 1 ? parts[0].start : nextDay(parts[2].end), periodEnd: end,
      filedAt: used.map(row => row.filed).sort().at(-1)!, ...values, dilutedShares: q.shares,
      latestQuarterEnd: end, latestQuarterFiledAt: q.filed, latestQuarterEps: q.income.val / q.shares,
      sourceIds: [...new Set(used.map(sourceId))] };
  }
  const current = build(currentParts), prior = build(priorParts);
  if (hasShareEvent(raw, current.latestQuarterEnd, today, today)) throw new DataUnavailable("最新股数期间之后有拆股相关披露，每股口径待核实");
  return { current, prior, evidence, warnings: [...new Set(warnings)] };
}

function hasShareEvent(raw: Json, after: string, through: string, today: string): boolean {
  const gaap = object(object(raw.facts)["us-gaap"]);
  for (const [tag, concept] of Object.entries(gaap)) {
    const isSplit = /StockSplit/i.test(tag), isStockDividend = /StockDividend/i.test(tag) && !/PreferredStockDividend|DividendRate|DividendYield/i.test(tag);
    if (!isSplit && !isStockDividend) continue;
    for (const [unit, rows] of Object.entries(object(object(concept).units))) {
      // Per-share cash dividends (USD/shares) and debt conversion ratios do not
      // establish a stock split; capital-event ratios and share quantities do.
      if (unit !== "pure" && unit !== "shares") continue;
      if (Array.isArray(rows) && rows.some(value => {
        const row = object(value), filed = day(row.filed), end = day(row.end);
        return filed && filed < today && end && end > after && end <= through &&
          typeof row.val === "number" && row.val !== 0 && !(isSplit && unit === "pure" && row.val === 1);
      })) {
        return true;
      }
    }
  }
  return false;
}
