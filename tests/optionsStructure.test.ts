import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  optionsStructure,
  type GexSnapshotItem,
} from "@/lib/options/structure";
import { optionsMap } from "@/lib/review/market";
import { optionsRowForDisplay } from "@/lib/review/options";
import { backfillOptionsStructures } from "@/lib/review/backfillOptions";
import { historicalGex } from "@/lib/review/history";

const base: GexSnapshotItem = {
  symbol: "SPX",
  spot: 100,
  gamma_flip: 99,
  put_wall: 95,
  call_wall: 105,
  net_gex: 10,
  as_of: "2026-09-22T16:00:00",
  status: "偏正",
};
describe("options structure: independent state and partial validity", () => {
  it("GEX sign never implies a flip relation; missing flip does not erase walls", () => {
    expect(optionsStructure({ ...base, gamma_flip: 101 })).toMatchObject({
      flip: "below",
      gamma: "positive",
    });
    expect(optionsStructure({ ...base, gamma_flip: null })).toMatchObject({
      flip: "unknown",
      gamma: "positive",
      wall: "inside",
    });
    expect(optionsStructure({ ...base, net_gex: null })).toMatchObject({
      flip: "above",
      gamma: "unknown",
      wall: "inside",
    });
    expect(optionsStructure({ ...base, spot: 0 })).toMatchObject({
      flip: "unknown",
      wall: "unknown",
    });
  });
  it("uses level as denominator and includes threshold boundary", () => {
    expect(
      optionsStructure({ ...base, spot: 100.2, gamma_flip: 100 }).flip,
    ).toBe("near");
    expect(
      optionsStructure({ ...base, spot: 99.8, gamma_flip: 100 }).flip,
    ).toBe("near");
    expect(
      optionsStructure({ ...base, spot: 100.201, gamma_flip: 100 }).flip,
    ).toBe("above");
    expect(
      optionsStructure({ ...base, spot: 102, gamma_flip: 100 }).distances.flip,
    ).toBe(2);
    expect(() => optionsStructure(base, {}, "snapshot", -1)).toThrow();
  });
  it("allows near both; no range percentile for coincident/reversed walls", () => {
    const s = optionsStructure({
      ...base,
      spot: 773.38,
      put_wall: 773,
      call_wall: 774,
    });
    expect(s.wall).toBe("near-both");
    expect(s.wallPercentile).toBeCloseTo(38);
    for (const call_wall of [95, 94])
      expect(optionsStructure({ ...base, call_wall })).toMatchObject({
        wall: "unknown",
        wallPercentile: null,
      });
    expect(
      optionsStructure({ ...base, put_wall: null, call_wall: 100 }),
    ).toMatchObject({ wall: "near-call" });
    expect(optionsStructure({ ...base, put_wall: null }).wall).toBe("unknown");
  });
  it("does not silently convert invalid/empty chain into zero gamma", () => {
    expect(
      optionsStructure({ ...base, net_gex: 0, contracts_used: 0 }),
    ).toMatchObject({ gamma: "unknown", flip: "unknown", wall: "unknown" });
    expect(optionsStructure({ ...base, net_gex: 0 }).gamma).toBe("zero");
    expect(optionsStructure({ ...base, net_gex: NaN }).gamma).toBe("unknown");
    expect(
      optionsStructure({
        ...base,
        quality: { invalid_fields: ["gamma_flip"], warnings: ["残差大"] },
      }),
    ).toMatchObject({ flip: "unknown", gamma: "positive" });
    expect(
      optionsStructure({
        ...base,
        gamma_flip: null,
        flip_search: { found: false, low: 94, high: 104 },
      }).issues,
    ).toContain("扫描范围内未找到 Flip");
  });
  it("reproduces the actual four-symbol September 22 positions", () => {
    const inputs = [
      [7764.64, 7692.11, 7700, 7765, 77e9, "above", "near-call"],
      [773.38, 769.75, 773, 774, 8e9, "above", "near-both"],
      [747.46, 736.73, 730, 748, 9e9, "above", "near-call"],
      [287.21, 292.66, 285, 290, -1e9, "below", "inside"],
    ] as const;
    for (const [
      spot,
      gamma_flip,
      put_wall,
      call_wall,
      net_gex,
      flip,
      wall,
    ] of inputs)
      expect(
        optionsStructure({
          ...base,
          spot,
          gamma_flip,
          put_wall,
          call_wall,
          net_gex,
        }),
      ).toMatchObject({ flip, wall });
  });
});

describe("options archives and comparison", () => {
  it("raw history retains provenance, quality and contract coverage", () => {
    const root = mkdtempSync(path.join(tmpdir(), "gex-history-"));
    const before = process.env.MARKET_DATA_DIR;
    process.env.MARKET_DATA_DIR = root;
    try {
      const current = {
        source: "cboe-delayed",
        method: "gex",
        method_version: "v1",
        fetched_at: "2026-09-23T01:00:00Z",
        dte: "0-45d",
        review: ["warning"],
        items: [
          {
            ...base,
            contracts_used: 3,
            quality: { invalid_fields: ["gamma_flip"], warnings: ["residual"] },
          },
        ],
      };
      expect(historicalGex("2026-09-22", current)).toEqual(current);
      expect(historicalGex("2026-09-22", null)).toEqual(current);
    } finally {
      if (before === undefined) delete process.env.MARKET_DATA_DIR;
      else process.env.MARKET_DATA_DIR = before;
      rmSync(root, { recursive: true, force: true });
    }
  });
  const metadata = {
    source: "cboe-delayed",
    method: "gex",
    method_version: "v1",
    dte: "0-45d",
  };
  const past = optionsMap(
    {
      ...metadata,
      items: [{ ...base, net_gex: -10, as_of: "2026-09-21T16:00:00" }],
    },
    [],
    "2026-09-21",
    null,
  );
  it("persists verified sign shifts, rejects other methods and dates", () => {
    const build = (extra = {}) =>
      optionsMap(
        { ...metadata, items: [base], ...extra },
        past,
        "2026-09-22",
        "2026-09-21",
      )[0];
    expect(build()).toMatchObject({
      comparison: "verified",
      structure: { version: "options-structure-v1", basis: "snapshot" },
    });
    expect(build().changes).toContain("Net GEX 由负转正");
    expect(build({ method_version: "v2" }).comparable).toBe(false);
    expect(build({ source: "other" }).shifts).toEqual([]);
    expect(build({ dte: "0-7d" }).comparable).toBe(false);
    expect(
      optionsMap({ items: [base] }, past, "2026-09-23", "2026-09-22")[0].today,
    ).toBeNull();
    expect(build({ items: [{ ...base, net_gex: null }] }).today?.spot).toBe(
      100,
    );
  });
  it("old rows render as reconstructed with unverified legacy comparisons", () => {
    const row = optionsRowForDisplay({
      symbol: "SPX",
      today: base,
      previous: base,
      dte: "0-45d",
      comparable: true,
      changes: [],
    });
    expect(row.structure?.basis).toBe("reconstructed");
    expect(row.comparison).toBe("legacy");
    expect(optionsRowForDisplay(row)).toBe(row);
  });
  it("backfill is idempotent and changes only options, with an original backup", () => {
    const root = mkdtempSync(path.join(tmpdir(), "options-archive-"));
    try {
      const dir = path.join(root, "snapshots/daily-review");
      mkdirSync(dir, { recursive: true });
      const review = {
        version: 1,
        date: "2026-09-22",
        previousDate: "2026-09-21",
        builtAt: "original",
        signals: [{ quality: 91 }],
        accounts: [{ equity: 100 }],
        market: { regime: "Unknown" },
        options: [
          {
            symbol: "SPX",
            today: base,
            previous: null,
            dte: "0-45d",
            comparable: false,
            changes: [],
          },
        ],
      };
      const file = path.join(dir, `${review.date}.json`);
      writeFileSync(file, JSON.stringify(review));
      expect(backfillOptionsStructures(root).changed).toEqual([review.date]);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(review);
      const result = backfillOptionsStructures(root, true);
      const after = JSON.parse(readFileSync(file, "utf8"));
      expect({ ...after, options: review.options }).toEqual(review);
      expect(after.options[0].structure.basis).toBe("reconstructed");
      expect(
        JSON.parse(
          readFileSync(
            path.join(result.backup!, `${review.date}.json`),
            "utf8",
          ),
        ),
      ).toEqual(review);
      expect(backfillOptionsStructures(root, true).changed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
