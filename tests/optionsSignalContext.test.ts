import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OptionsSignalStudy,
  FrozenSignalOptions,
} from "@/components/review/OptionsSignalStudy";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPTION_SYMBOLS,
  makeOptionsPublication,
  freezeOptionsContext,
  quoteTimestamp,
  validFrozenOptions,
  type OptionsPublication,
} from "@/lib/options/signalContext";
import { optionsMap } from "@/lib/review/market";
import {
  optionsContextBefore,
  publishOptionsContext,
} from "@/lib/review/optionsContextStore";
import { optionsStudy } from "@/lib/review/optionsStudy";
import {
  evaluateEntry,
  journalAsOf,
  mergeEvaluation,
} from "@/lib/review/journal";
import { assessedAlertView, tradeIdOf } from "@/lib/signals/journal";
import type { EntrySnapshot } from "@/lib/signals/assessment";
import type { JournalSignal, OptionsRow } from "@/lib/review/types";
import * as snapshots from "@/lib/vps/snapshot";

const quoteDate = "2026-09-22",
  signalDate = "2026-09-23";
const time = Date.parse("2026-09-23T15:30:00Z");
const capturedAt = new Date(time + 1000).toISOString();
const publishedAt = "2026-09-23T00:30:00Z";
function rows(date = quoteDate): OptionsRow[] {
  return optionsMap(
    {
      source: "cboe-delayed",
      method: "gex(S)",
      method_version: "cboe-gex-v2",
      dte: "0-45d",
      fetched_at: `${date}T21:00:00+00:00`,
      items: OPTION_SYMBOLS.map((symbol) => ({
        symbol,
        spot: 100,
        gamma_flip: 98,
        call_wall: 105,
        put_wall: 95,
        net_gex: 10,
        status: "偏正",
        as_of: `${date}T16:00:00`,
        contracts_used: 10,
      })),
    },
    [],
    date,
    null,
  );
}
function publication(): OptionsPublication {
  return makeOptionsPublication(quoteDate, rows(), publishedAt, signalDate)!;
}
function entry(): EntrySnapshot {
  return {
    version: 1,
    id: "sample",
    capturedAt,
    payload: {
      event: "buy",
      symbol: "NASDAQ:TEST",
      tf: "120",
      kind: 1,
      price: 100,
      entrySignalTime: time,
      barTime: time,
      strategyKey: "test-options",
    },
    quality: {
      version: "quality-v5",
      points: 80,
      available: 100,
      complete: true,
      label: "test",
      dimensions: [],
    },
    optionsContext: freezeOptionsContext(publication(), time, capturedAt),
  };
}
const sessions = [
  signalDate,
  "2026-09-24",
  "2026-09-25",
  "2026-09-28",
  "2026-09-29",
  "2026-09-30",
];
function signal(value = 2, id = "a"): JournalSignal {
  const bars = sessions.map((date, i) => ({
    date,
    close: i ? 100 + value : 100,
    open: 100,
    high: 105,
    low: 97,
    volume: 100,
  }));
  return {
    ...evaluateEntry(
      entry(),
      sessions,
      { raw: bars, split: bars },
      sessions[5],
    )!,
    id,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("option evidence availability", () => {
  it("parses NY summer/winter quotes; rejects ambiguous DST and missing dates", () => {
    expect(quoteTimestamp("2026-09-22T16:00:00")).toBe(
      Date.parse("2026-09-22T20:00:00Z"),
    );
    expect(quoteTimestamp("2026-01-22T16:00:00")).toBe(
      Date.parse("2026-01-22T21:00:00Z"),
    );
    expect(quoteTimestamp("2026-09-22T20:00:00Z")).toBe(
      Date.parse("2026-09-22T20:00:00Z"),
    );
    expect(quoteTimestamp("2026-11-01T01:30:00")).toBeNull();
    expect(quoteTimestamp("2026-03-08T02:30:00")).toBeNull();
    expect(quoteTimestamp("2026-02-30T16:00:00")).toBeNull();
    expect(quoteTimestamp("2026-09-22")).toBeNull();
  });
  it("requires a publication before signal, correct next session and bounded capture lag", () => {
    const p = publication();
    expect(freezeOptionsContext(p, time, capturedAt, quoteDate).status).toBe(
      "available",
    );
    expect(
      freezeOptionsContext({ ...p, publishedAt: capturedAt }, time, capturedAt)
        .reason,
    ).toBe("future");
    expect(
      freezeOptionsContext(
        { ...p, publishedAt: "2026-09-23 00:30:00" },
        time,
        capturedAt,
      ).reason,
    ).toBe("invalid");
    expect(freezeOptionsContext(p, time, capturedAt, "2026-09-21").reason).toBe(
      "stale",
    );
    expect(
      freezeOptionsContext(
        { ...p, validForSession: "2026-09-24" },
        time,
        capturedAt,
      ).reason,
    ).toBe("stale");
    expect(
      freezeOptionsContext(p, time, new Date(time + 16 * 60_000).toISOString())
        .reason,
    ).toBe("delayed-signal");
    expect(freezeOptionsContext(null, time, capturedAt).reason).toBe(
      "not-published",
    );
  });
  it("rejects edited/future states; a missing field remains partial, not zero", () => {
    const p = publication();
    p.items[0].structure.gamma = "negative";
    expect(freezeOptionsContext(p, time, capturedAt).reason).toBe("invalid");
    const future = publication();
    future.items[0].raw!.as_of = "2026-09-23T16:00:00";
    expect(freezeOptionsContext(future, time, capturedAt).status).toBe(
      "missing",
    );
    const partial = rows();
    partial[0].today!.gamma_flip = null;
    const context = freezeOptionsContext(
      makeOptionsPublication(quoteDate, partial, publishedAt, signalDate),
      time,
      capturedAt,
    );
    expect(context.status).toBe("partial");
    expect(context.publication?.items[0].structure).toMatchObject({
      flip: "unknown",
      gamma: "positive",
    });
    partial[0].today!.net_gex = -1;
    expect(context.publication?.items[0].raw?.net_gex).toBe(10);
    expect(
      validFrozenOptions({ ...context, signalTime: time - 1 }, time),
    ).toBeNull();
    expect(validFrozenOptions(context, time, publishedAt)).toBeNull();
    const lateFetch = publication();
    lateFetch.items[0].structure.provenance.fetched_at = capturedAt;
    expect(freezeOptionsContext(lateFetch, time, capturedAt).reason).toBe(
      "future",
    );
  });
  it("publication uses calendar next session across a holiday; stamps current publication time", () => {
    const save = vi
      .spyOn(snapshots, "writeSnapshot")
      .mockImplementation(() => {});
    const friday = rows("2026-09-04");
    const p = publishOptionsContext(
      "2026-09-04",
      friday,
      ["2026-09-04", "2026-09-08"],
      "2026-09-08T12:00:00Z",
    );
    expect(p?.validForSession).toBe("2026-09-08");
    expect(p?.publishedAt).toBe("2026-09-08T12:00:00Z");
    expect(save).toHaveBeenCalledWith("daily-review/options-context", p);
    expect(
      publishOptionsContext("2026-09-04", friday, ["2026-09-04"]),
    ).toBeNull();
    expect(
      publishOptionsContext("2026-09-04", friday, ["2026-09-08"]),
    ).toBeNull();
    expect(
      publishOptionsContext("2026-09-04", friday, ["2026-09-08", "2026-09-04"]),
    ).toBeNull();
  });
  it("fetch failures are recorded and cannot block signal handling", async () => {
    vi.spyOn(snapshots, "readSnapshot").mockRejectedValue(new Error("down"));
    expect((await optionsContextBefore(time, capturedAt)).reason).toBe(
      "unavailable",
    );
  });
});

describe("immutable signal options", () => {
  it("real alert path saves options even without market regime, duplicates cannot overwrite", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "options-alert-"));
    vi.stubEnv("SIGNAL_JOURNAL_DIR", root);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(capturedAt));
    const source = publication();
    vi.spyOn(snapshots, "readSnapshot").mockImplementation(async (name) =>
      name === "daily-review/options-context" ? structuredClone(source) : null,
    );
    try {
      const e = entry();
      await assessedAlertView(e.payload, "2H", 80);
      const file = path.join(
        root,
        "signal-entries",
        `${tradeIdOf(e.payload)}.json`,
      );
      const before = readFileSync(file, "utf8"),
        saved = JSON.parse(before) as EntrySnapshot;
      expect(saved.marketContext).toBeUndefined();
      expect(saved.optionsContext?.status).toBe("available");
      source.items[0].raw!.net_gex = -99;
      await assessedAlertView(e.payload, "2H", 20);
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("evaluation preserves the original frozen evidence, and never backfills old missing labels", () => {
    const old = signal();
    const updated = signal(4);
    updated.optionsContext!.publication!.items[0].structure.gamma = "negative";
    expect(mergeEvaluation(old, updated).optionsContext).toEqual(
      old.optionsContext,
    );
    const legacy = { ...old };
    delete legacy.optionsContext;
    expect(mergeEvaluation(legacy, updated).optionsContext).toBeUndefined();
    const earlier = journalAsOf([old], signalDate)[0];
    expect(earlier.outcomes.t5.status).toBe("pending");
    expect(earlier.optionsContext).toEqual(old.optionsContext);
  });
});

describe("options study: comparable denominators", () => {
  it("renders populated groups and frozen evidence without exposing future returns", () => {
    const sample = signal(2);
    const view = (date: string) =>
      renderToStaticMarkup(
        createElement(OptionsSignalStudy, { signals: [sample], date }),
      );
    const matured = view(sessions[5]);
    expect(matured).toContain("T+5 均值");
    expect(matured).toContain("+2.00%");
    expect(matured).toContain("GEX 为正");
    expect(matured).not.toContain("等待信号前冻结的期权结构");
    expect(view(signalDate)).not.toContain("+2.00%");
    const detail = renderToStaticMarkup(
      createElement(FrozenSignalOptions, { signal: sample }),
    );
    expect(detail).toContain(quoteDate);
    expect(detail).toContain("非信号时刻实时 Gamma");
  });
  it("counts mature/pending/missing separately; no future outcomes in historical view", () => {
    const ready = signal(2),
      pending = signal(99, "b"),
      missing = signal(99, "c");
    pending.outcomes.t5 = { date: "2026-10-01", status: "ready", value: 99 };
    missing.outcomes.t5 = { date: sessions[5], status: "missing", value: null };
    const r = optionsStudy([ready, pending, missing], "SPX", "t5", sessions[5]);
    expect(r.baseline).toMatchObject({
      n: 1,
      pending: 1,
      missing: 1,
      days: 1,
      mean: expect.closeTo(2),
      median: expect.closeTo(2),
      winRate: 100,
    });
    expect(optionsStudy([ready], "SPX", "t5", signalDate).baseline.n).toBe(0);
  });
  it("keeps same-day clusters from dominating the day-weighted mean", () => {
    const a = signal(10),
      b = signal(10, "b"),
      c = signal(-10, "c");
    const nextTime = time + 86400_000,
      nextCapture = new Date(nextTime + 1000).toISOString();
    const nextPub = makeOptionsPublication(
      signalDate,
      rows(signalDate),
      "2026-09-24T00:30:00Z",
      "2026-09-24",
    )!;
    c.date = "2026-09-24";
    c.signalTime = nextTime;
    c.capturedAt = nextCapture;
    c.optionsContext = freezeOptionsContext(nextPub, nextTime, nextCapture);
    const report = optionsStudy([a, b, c], "SPX", "t5", sessions[5]);
    expect(report.baseline.n).toBe(3);
    expect(report.baseline.days).toBe(2);
    expect(report.baseline.mean).toBeCloseTo(10 / 3);
    expect(report.baseline.dayMean).toBeCloseTo(0);
  });
  it("does not mix methods, DTE, missing evidence, replays or incomplete scores", () => {
    const a = signal(),
      other = signal(100, "b"),
      legacy = signal(100, "c"),
      partial = signal(100, "d"),
      replay = signal(100, "e"),
      metadata = signal(100, "f");
    const r = rows();
    r[0].dte = "0-7d";
    other.optionsContext = freezeOptionsContext(
      makeOptionsPublication(quoteDate, r, publishedAt, signalDate),
      time,
      capturedAt,
    );
    delete legacy.optionsContext;
    partial.quality = { ...partial.quality, complete: false };
    replay.source = "replay";
    const unknown = rows();
    unknown[0].meta = {};
    metadata.optionsContext = freezeOptionsContext(
      makeOptionsPublication(quoteDate, unknown, publishedAt, signalDate),
      time,
      capturedAt,
    );
    const report = optionsStudy(
      [a, other, legacy, partial, replay, metadata],
      "SPX",
      "t5",
      sessions[5],
    );
    expect(report.variants).toHaveLength(2);
    expect(report.total).toBe(1);
    expect(report.otherRules).toBe(1);
    expect(report.excluded).toMatchObject({
      unrecorded: 1,
      incomplete: 1,
      replay: 1,
      metadata: 1,
    });
    expect(report.groups[0].rows.reduce((n, row) => n + row.n, 0)).toBe(1);
    expect(
      optionsStudy([a, other], "QQQ", "t1", sessions[5]).variants,
    ).toHaveLength(1);
  });
  it("five-day excursions exclude incomplete observations; unknown flip stays its own group", () => {
    const a = signal();
    a.excursions.pop();
    const r = rows();
    r[0].today!.gamma_flip = null;
    a.optionsContext = freezeOptionsContext(
      makeOptionsPublication(quoteDate, r, publishedAt, signalDate),
      time,
      capturedAt,
    );
    const report = optionsStudy([a], "SPX", "t3", sessions[5]);
    expect(report.baseline.excursionN).toBe(0);
    expect(report.baseline.mae).toBeNull();
    expect(report.groups[0].rows.find((g) => g.label === "Flip 未知")?.n).toBe(
      1,
    );
  });
});
