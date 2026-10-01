import { describe, expect, it } from "vitest";
import { bookCache, bookCheckpoint, bookView } from "./liveBooksFixtures";
import { buildSignalReconciliation, parseTvStrategyKey, signalReconciliationReportOf, type TvJournalEvidence, type TvJournalReadResult } from "@/lib/fund/signalReconciliation";
import type { SignalTracking } from "@/lib/fund/signalTracking";

const start = "2026-09-28T13:30:00.000Z", close = "2026-09-28T17:30:00.000Z";
const parameters = { timeframe: "4h" as const, stopMult: 4, trailMult: 6, takeProfitR: 3, useBuy1: true, useBuy2: true, requireRsi: true, minRsi: 30, requireVegas: true, entryAtDayCloseOnly: false };
const key = (target = "3", symbol = "CSCO") => `aa-4h-v1|NASDAQ:${symbol}|240|4|6|${target}|true|true|true|30|true|false`;
const tv = (over: Partial<TvJournalEvidence> = {}): TvJournalEvidence => ({ id: "a".repeat(64), symbol: "CSCO", tf: "4h", event: "buy", signalTime: close, entrySignalTime: close, signalBarOpenTime: start, entrySignalBarOpenTime: start, price: 80, kind: 1, strategyKey: key(), capturedAt: close, ...over });
const journal = (records: TvJournalEvidence[]): TvJournalReadResult => ({ records, availability: "ok", from: "2026-08-01T00:00:00.000Z", through: "2026-10-01T00:00:00.000Z", truncated: false, parametersByTf: { "4h": parameters } });
function cache(events?: SignalTracking["events"]) {
  const tracking: SignalTracking = { version: 1, activatedAt: "2026-09-20T00:00:00.000Z", asOf: close, parameters, states: {}, accounts: {}, events: events ?? [{ id: "e", signalId: "s", symbol: "CSCO", type: "buy", signalDate: start, signalTime: close, signalTimeEstimated: true, entrySignalDate: start, signalPrice: 80, kind: 1, status: "skipped", reason: "cash" }], migration: { at: close, positions: [], pending: [] } };
  return bookCache({ books: [{ tf: "4h", name: "4 小时", view: bookView({ asOf: "2026-09-29T17:30", rows: [], fills: [] }), checkpoint: { ...bookCheckpoint(), signalTracking: tracking } }] });
}

describe("TV strategy identity", () => {
  it("parses complete 4H and 2H Pine identities and rejects loose guesses", () => {
    expect(parseTvStrategyKey(key(), "CSCO", "4h")).toMatchObject({ takeProfitR: 3, stopMult: 4 });
    expect(parseTvStrategyKey("aa-2h-v1|NASDAQ:CSCO|120|4|5|true|true|true|30|true|false", "CSCO", "2h")).toMatchObject({ takeProfitR: null });
    for (const invalid of ["aa-4h-v1|4|6|3", key("2.5junk"), key().replace("|true|", "|1|"), key() + "|extra", key("3", "GOOG")]) expect(parseTvStrategyKey(invalid, "CSCO", "4h")).toBeNull();
    expect(parseTvStrategyKey(key(), "CSCO", "2h")).toBeNull();
  });
});

it("reports actual 2.5R versus 3R parameters independently of the cash skip", () => {
  const report = buildSignalReconciliation(cache(), journal([tv({ strategyKey: key("2.5") })]));
  expect(report.rows).toHaveLength(1);
  expect(report.rows[0]).toMatchObject({ status: "different", parameterDifferences: [{ field: "takeProfitR", local: 3, tv: 2.5 }] });
  expect(report.rows[0].summary).not.toContain("漏推");
});

it("matches original signal bars, flags price differences, and never merges GOOG with GOOGL", () => {
  expect(buildSignalReconciliation(cache(), journal([tv()])).rows[0].status).toBe("matched");
  expect(buildSignalReconciliation(cache(), journal([tv({ price: 80.2 })])).rows[0].differences.join(" ")).toContain("价格");
  const other = tv({ symbol: "GOOGL", strategyKey: key("3", "GOOGL") });
  expect(buildSignalReconciliation(cache(), journal([other])).rows).toHaveLength(2);
});

it("does not certify estimated close times without an original TV bar boundary", () => {
  const record = tv({ signalBarOpenTime: undefined, entrySignalBarOpenTime: undefined });
  expect(buildSignalReconciliation(cache(), journal([record])).rows[0].status).toBe("unverifiable");
});

it("uses original entry identity to compare exits and labels a different exit bar", () => {
  const events = cache().books[0].checkpoint!.signalTracking!.events;
  events.push({ id: "sell", signalId: "s", symbol: "CSCO", type: "sell", signalDate: "2026-09-29T13:30:00Z", signalTime: "2026-09-29T17:30:00Z",
    signalTimeEstimated: true, entrySignalDate: start, signalPrice: 79, kind: 1, status: "observed", reason: "stop" });
  const exit = tv({ event: "sell", signalTime: "2026-09-29T20:00:00.000Z", signalBarOpenTime: "2026-09-29T17:30:00.000Z", entrySignalBarOpenTime: undefined, price: 79 });
  const report = buildSignalReconciliation(cache(events), journal([tv(), exit]));
  expect(report.rows.find(r => r.event === "sell")).toMatchObject({ status: "different" });
  expect(report.rows.find(r => r.event === "sell")!.differences.join(" ")).toContain("K 线时间不同");
});

it("does not compare a 2H archive to a 4H signal and strips extra report properties", () => {
  const other = tv({ tf: "2h", strategyKey: "aa-2h-v1|NASDAQ:CSCO|120|4|5|true|true|true|30|true|false" });
  expect(buildSignalReconciliation(cache(), journal([other])).rows).toHaveLength(1);
  const report = buildSignalReconciliation(cache(), journal([tv()]));
  const result = signalReconciliationReportOf({ ...report, payload: { token: "private" }, rows: report.rows.map(r => ({ ...r, chart: "private" })) });
  expect(JSON.stringify(result)).not.toContain("private");
});

it("compares old account fills only to explicit TV entryTime, never to the signal close", () => {
  const old = bookCache({ books: [{ tf: "4h", name: "4 小时", view: bookView({ asOf: "2026-09-29T17:30", fills: [{ symbol: "CSCO", side: "buy", date: "2026-09-28T17:30", price: 80.1 }] }) }] });
  expect(buildSignalReconciliation(old, journal([tv()])).rows[0]).toMatchObject({ status: "unverifiable", evidence: "account_fill" });
  expect(buildSignalReconciliation(old, journal([tv()])).rows[0].localFillTime).toBeUndefined();
  const explicit = tv({ event: "sell", entryTime: close, entryPrice: 80.1, signalTime: "2026-09-29T20:00:00.000Z" });
  expect(buildSignalReconciliation(old, journal([explicit])).rows[0]).toMatchObject({ status: "unverifiable", evidence: "account_fill", localFillTime: close, tvEntryTime: close });
  expect(buildSignalReconciliation(old, journal([{ ...explicit, entryPrice: 81 }])).rows[0].status).toBe("different");
});

it("missing archives and unavailable storage do not claim missed notifications", () => {
  const missing = buildSignalReconciliation(cache(), journal([]));
  expect(missing.rows[0].status).toBe("tv_record_not_found");
  expect(missing.rows[0].summary).toContain("未找到");
  const unavailable = buildSignalReconciliation(cache(), { ...journal([]), availability: "unavailable", reason: "归档读取失败" });
  expect(unavailable).toMatchObject({ availability: "unavailable", rows: [] });
  expect(signalReconciliationReportOf(missing)).toEqual(missing);
  expect(signalReconciliationReportOf({ ...missing, rows: [{}] })).toBeNull();
  expect(signalReconciliationReportOf({ ...missing, generatedAt: "invalid" })).toBeNull();
});

it("rejects date-shaped arrays in a saved report instead of crashing the account page", () => {
  const report = buildSignalReconciliation(cache(), journal([tv()]));
  expect(signalReconciliationReportOf({ ...report, generatedAt: [report.generatedAt] })).toBeNull();
  expect(signalReconciliationReportOf({ ...report, generatedAt: [report.generatedAt.replace(/Z$/, "")] })).toBeNull();
  expect(signalReconciliationReportOf({ ...report, coverage: { ...report.coverage, from: [report.coverage.from] } })).toBeNull();
  expect(signalReconciliationReportOf({ ...report, coverage: { ...report.coverage, from: [report.coverage.from.replace(/Z$/, "")] } })).toBeNull();
  expect(signalReconciliationReportOf({ ...report, rows: report.rows.map(row => ({ ...row, localSignalTime: [row.localSignalTime] })) })).toBeNull();
});

it("does not certify a different or missing original buy type", () => {
  const different = buildSignalReconciliation(cache(), journal([Object.assign(tv(), { kind: 2 as const })])).rows[0];
  expect(different.status).toBe("different");
  expect(different.differences.join(" ")).toContain("买点类型");
  const missingType = { ...tv() } as TvJournalEvidence & { kind?: 1 | 2 };
  delete missingType.kind;
  const missing = buildSignalReconciliation(cache(), journal([missingType])).rows[0];
  expect(missing.status).toBe("unverifiable");
  expect(missing.differences.join(" ")).toContain("缺少买点类型");
});
