/** 离线验证公开 SEC Company Facts 与本地历史日线；不请求网络、不更新快照、不发送消息。
 * --facts-dir=目录 --market-dir=日线CSV目录 --from=2021-08-24 --to=2026-09-09 --out=报告.json
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fundInputsFromSecFacts, type SecFactsFile, type SecFact } from "@/lib/data-sources/secFacts";
import { parseCsvText } from "@/lib/backtest/csvPanel";
import { distFrom52w } from "@/lib/jobs/fundScore";
import { fundScoreOf } from "@/lib/scoring/fundScore";

function arg(name: string): string {
  const value = process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
const factsDir = arg("facts-dir"), marketDir = arg("market-dir"), from = arg("from"), to = arg("to"), out = arg("out");
assert(from <= to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to));
const DAY = 86400000;
const delta = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;

function mapFacts(facts: SecFactsFile, transform: (rows: SecFact[]) => SecFact[]): SecFactsFile {
  return { facts: { "us-gaap": Object.fromEntries(Object.entries(facts.facts?.["us-gaap"] ?? {}).map(([name, fact]) => [name,
    { units: Object.fromEntries(Object.entries(fact.units ?? {}).map(([unit, rows]) => [unit, transform(rows)])) }])) } };
}
function periods(facts: SecFactsFile, tag: string, asOf: string): SecFact[] {
  const unique = new Map<string, SecFact>();
  const rows = [...(facts.facts?.["us-gaap"]?.[tag]?.units?.USD ?? [])]
    .filter((r) => r.filed && r.filed <= asOf && r.end && r.end <= asOf && /^10-[KQ](\/A)?$/.test(r.form ?? ""))
    .sort((a, b) => `${a.filed}/${a.accn}`.localeCompare(`${b.filed}/${b.accn}`));
  for (const r of rows) unique.set(`${r.start}/${r.end}`, r);
  return [...unique.values()].sort((a, b) => a.end!.localeCompare(b.end!));
}
/** 按原始披露的“上年全年 + 本年累计 - 上年同期累计”独立对账，不调用生产代码的期间整理函数。 */
function cumulativeTtm(facts: SecFactsFile, tag: string, asOf: string): { value: number; end: string } | null {
  const rows = periods(facts, tag, asOf).filter((r) => r.start && r.end && r.val != null);
  const latest = rows.at(-1)?.end;
  const annual = rows.filter((r) => delta(r.start!, r.end!) >= 350 && delta(r.start!, r.end!) <= 380).at(-1);
  if (!latest || !annual) return null;
  if (annual.end === latest) return { value: annual.val!, end: latest };
  const start = new Date(Date.parse(annual.end!) + DAY).toISOString().slice(0, 10);
  const current = rows.find((r) => r.start === start && r.end === latest);
  const previous = rows.filter((r) => r.start === annual.start && Math.abs(delta(r.end!, latest) - 365) <= 14).at(-1);
  if (!current || !previous) return null;
  return { value: annual.val! + current.val! - previous.val!, end: latest };
}
const dates = new Set([from, to]);
for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) < to;) {
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  if (end >= from && end <= to) dates.add(end);
  d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}
const results = [];
let reconciliations = 0;
const mismatches: object[] = [];
const symbols: string[] = [];
for (const file of readdirSync(factsDir).filter((f) => /^[A-Z]+\.json$/.test(f)).sort()) {
  const symbol = file.slice(0, -5), facts: SecFactsFile = JSON.parse(readFileSync(path.join(factsDir, file), "utf8"));
  assert(facts.facts, `${file}: not SEC Company Facts`);
  const bars = parseCsvText(symbol, readFileSync(path.join(marketDir, `${symbol}.csv`), "utf8"))!;
  symbols.push(symbol);
  for (const asOf of [...dates].sort()) {
    const input = fundInputsFromSecFacts(facts, asOf);
    const known = mapFacts(facts, (rows) => rows.filter((r) => r.filed && r.filed <= asOf && r.end && r.end <= asOf));
    assert.deepEqual(fundInputsFromSecFacts(known, asOf), input, `${symbol} ${asOf} future disclosure leaked`);
    const repeated = mapFacts(known, (rows) => [...rows, ...rows].reverse());
    assert.deepEqual(fundInputsFromSecFacts(repeated, asOf), input, `${symbol} ${asOf} duplicate/order changed result`);
    const closes = Array.from(bars.close).filter((_, i) => bars.dates[i].slice(0, 10) <= asOf);
    const score = fundScoreOf({ ...input, dist52w: distFrom52w(closes) });
    assert(Object.values(input).every((v) => v == null || Number.isFinite(v)));
    assert(score.total >= 0 && score.total <= 100 && (score.usable || score.tier === null));
    const ni = cumulativeTtm(facts, "NetIncomeLoss", asOf);
    const equity = periods(facts, "StockholdersEquity", asOf).filter((r) => !r.start).at(-1);
    const gp = cumulativeTtm(facts, "GrossProfit", asOf);
    const revs = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"]
      .map((tag) => cumulativeTtm(facts, tag, asOf)).filter((v) => v != null).sort((a, b) => b.end.localeCompare(a.end));
    const rev = revs[0];
    const checks: [string, number | null, number | null][] = [
      ["roe", input.roe, ni && equity?.val && ni.end === equity.end && equity.val > 0 ? ni.value / equity.val : null],
      ["gmTtm", input.gmTtm, gp && rev && gp.end === rev.end && rev.value > 0 ? gp.value / rev.value : null],
    ];
    for (const [metric, actual, expected] of checks) {
      if (actual == null || expected == null) continue;
      reconciliations++;
      // 财报以千/百万为单位四舍五入，允许比率 0.01 个百分点误差。
      if (Math.abs(actual - expected) > .0001) mismatches.push({ symbol, asOf, metric, actual, expected });
    }
    results.push({ symbol, asOf, ...input, score: score.total, tier: score.tier, filled: score.filled });
  }
  console.log(`[SEC history] ${symbol} ${dates.size} dates checked`);
}
assert(symbols.length > 0, "No Company Facts files found");
const report = { from, to, symbols, snapshots: results.length, usable: results.filter((r) => r.tier != null).length,
  reconciliations, mismatches, results };
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, results: undefined }));
assert.equal(mismatches.length, 0, `Financial reconciliation mismatches: see ${out}`);
