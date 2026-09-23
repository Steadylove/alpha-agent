import { describe, it, expect, vi, afterEach } from "vitest";
import {
  marketEngine,
  priceState,
  breadthMomentum,
  volatilityState,
  type MarketFrame,
} from "@/lib/review/engine";
import {
  macroEnvironment,
  mergeObservations,
  MACRO_SERIES,
  type MacroArchive,
  type MacroId,
} from "@/lib/review/macro";
import { parseFredCsv } from "@/lib/data-sources/reviewMacro";
import {
  marketReview,
  sectorStrength,
  REVIEW_SECTORS,
  type Bars,
} from "@/lib/review/market";
import { marketContextBefore } from "@/lib/review/store";
import * as snapshots from "@/lib/vps/snapshot";

const days = ["2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22"];
const frame = (
  changes = [0.7, 1, 0.6],
  breadth = 65,
  priorBreadth = 60,
  vix = -1,
): MarketFrame => ({
  date: days[3],
  metrics: ["SPY", "QQQ", "IWM", "SPX", "VIX"].map((symbol, i) => ({
    symbol,
    today: symbol === "VIX" ? 18 : 100,
    yesterday: 100,
    change: i < 3 ? changes[i] : i === 3 ? changes[0] : vix,
  })),
  breadth,
  priorBreadth,
  sectorUp: 8,
  sectorPrevious: 8,
  sector5dUp: 7,
  defensiveSpread: 0,
});
const past = (f: MarketFrame) => ({ ...f, date: days[2] });
describe("市场状态 v2：状态、速度与领导结构分别计算", () => {
  it("精确噪音边界不被误判成趋势", () => {
    expect(priceState(0.2)).toBe("Neutral");
    expect(priceState((100.2 / 100 - 1) * 100)).toBe("Neutral");
    expect(priceState(-0.2)).toBe("Neutral");
    expect(priceState(1)).toBe("Strong Up");
    expect(priceState(-1)).toBe("Strong Down");
    expect(breadthMomentum(5)).toBe("Neutral");
    expect(breadthMomentum(-5)).toBe("Neutral");
    expect(breadthMomentum(15)).toBe("Improving");
    expect(breadthMomentum(-15.01)).toBe("Strong Deteriorating");
    expect(volatilityState(0.41)).toBe("Stable");
    expect(volatilityState(2)).toBe("Stable");
    expect(volatilityState(-5)).toBe("Mildly Falling");
  });
  it("低位升温与高位降温不同；修复可以同时成长领先、小盘落后", () => {
    const low = marketEngine([frame([0.7, 1.2, 0], 36, 20)]);
    expect(low.temperature).toMatchObject({
      level: "Weak",
      momentum: "Strong Improving",
    });
    expect(low.state).toBe("Narrow Rally");
    const high = marketEngine([frame([0.8, 0.8, 0.8], 75, 85)]);
    expect(high.temperature).toMatchObject({
      level: "Broad",
      momentum: "Deteriorating",
    });
    expect(high.state).toBe("Broad Risk-On");
    const recovery = marketEngine([
      { ...frame([0.7, 1.2, 0], 58, 31), sectorUp: 5, sectorPrevious: 6 },
    ]);
    expect(recovery.state).toBe("Risk-On Recovery");
    expect(recovery.structure).toMatchObject({
      leadership: "Growth-led",
      smallCap: "Lagging",
    });
  });
  it("扩张必须有参与度、板块与小盘支持；轻微分化默认为中性", () => {
    expect(
      marketEngine([
        { ...frame([1, 1, 1], 68, 42), sectorUp: 9, sectorPrevious: 4 },
      ]).state,
    ).toBe("Risk-On Expansion");
    expect(marketEngine([frame([0.01, -0.02, 0.03], 52, 51, 0.41)]).state).toBe(
      "Neutral",
    );
  });
  it("Transition 要当前存在冲突且近三日两次；已消失的冲突不延续标签", () => {
    const f = frame([0.7, 1, -0.7], 42, 68, 8);
    expect(marketEngine([f]).state).not.toBe("Transition");
    expect(marketEngine([f, past(f)]).state).toBe("Transition");
    expect(
      marketEngine([frame(), past(f), { ...f, date: days[1] }]).state,
    ).not.toBe("Transition");
    const rotation = frame([0.6, -0.8, 0], 50, 50, 0);
    expect(marketEngine([rotation]).state).toBe("Neutral");
    expect(marketEngine([rotation, past(rotation)]).state).toBe("Rotation");
  });
  it("显著风险收缩和关键数据缺失有独立状态", () => {
    expect(marketEngine([frame([-1, -1.2, -0.6], 22, 32, 8)]).state).toBe(
      "Risk-Off",
    );
    const f = frame();
    f.breadth = null;
    expect(marketEngine([f]).state).toBe("Unknown");
    const missingVix = frame();
    missingVix.metrics = missingVix.metrics.filter((m) => m.symbol !== "VIX");
    expect(marketEngine([missingVix]).state).toBe("Unknown");
  });
});
const fetchedAt = "2026-09-23T01:00:00Z";
function archive(
  changes: Partial<Record<MacroId, number>> = {},
  end = days[3],
): MacroArchive {
  return {
    version: 1,
    updatedAt: fetchedAt,
    errors: [],
    series: Object.fromEntries(
      MACRO_SERIES.map((def) => [
        def.id,
        days
          .filter((d) => d <= end)
          .map((d, i) => ({
            observationDate: d,
            value:
              def.provider === "fred"
                ? 4 + i * (changes[def.id] ?? 0.05)
                : 100 + i * (changes[def.id] ?? 0.5),
            availableAt: fetchedAt,
            fetchedAt,
          })),
      ]),
    ),
  };
}
describe("宏观环境：日期、发布延迟、单位和修订", () => {
  it("FRED 空值不变成零，利率用 bp", () => {
    expect(
      parseFredCsv(
        "observation_date,DGS10\n2026-09-18,4.05\n2026-09-21,\n2026-09-22,.\n",
        "DGS10",
      ),
    ).toEqual([{ observationDate: days[1], value: 4.05 }]);
    const a = macroEnvironment(archive(), days[3], days, fetchedAt);
    expect(a.rows[0].change).toBeCloseTo(5);
    expect(a.rows[0].changeUnit).toBe("bp");
    expect(a.regime).toBe("Restrictive");
    expect(
      macroEnvironment(
        archive({ DGS10: 0.03, DGS2: 0.03, DXY: 0 }),
        days[3],
        days,
        fetchedAt,
      ).regime,
    ).toBe("Neutral");
  });
  it("未可见数据不进入实时上下文；历史重建明确标注", () => {
    expect(
      macroEnvironment(archive(), days[3], days, "2026-09-22T21:00:00Z").regime,
    ).toBe("Unknown");
    expect(
      macroEnvironment(archive(), days[3], days, "2026-09-22T21:00:00Z", true)
        .basis,
    ).toBe("reconstructed");
    const old = macroEnvironment(archive(), days[1], days, fetchedAt, true);
    expect(old.rows.every((r) => r.observationDate! <= days[1])).toBe(true);
  });
  it("利率一交易日发布延迟单列；共同标签使用同一天，过期美元不判中性", () => {
    const a = archive();
    a.series.DGS10 = a.series.DGS10!.slice(0, -1);
    a.series.DGS2 = a.series.DGS2!.slice(0, -1);
    const result = macroEnvironment(a, days[3], days, fetchedAt);
    expect(result.rows[0].status).toBe("delayed");
    expect(result.effectiveDate).toBe(days[2]);
    a.series.DXY = a.series.DXY!.slice(0, -1);
    expect(macroEnvironment(a, days[3], days, fetchedAt).regime).toBe(
      "Unknown",
    );
    a.series.DGS10 = a.series.DGS10!.slice(0, -1);
    expect(macroEnvironment(a, days[3], days, fetchedAt).rows[0].status).toBe(
      "stale",
    );
  });
  it("跳过缺失交易日不拼接成单日变化；利率负值有效", () => {
    const a = archive();
    a.series.DGS10 = a.series.DGS10!.filter(
      (r) => r.observationDate !== days[2],
    );
    expect(
      macroEnvironment(a, days[3], days, fetchedAt).rows[0].change,
    ).toBeNull();
    expect(macroEnvironment(a, days[3], days, fetchedAt).regime).toBe(
      "Unknown",
    );
    a.series.DGS10 = [
      {
        observationDate: days[2],
        value: -0.5,
        availableAt: fetchedAt,
        fetchedAt,
      },
      {
        observationDate: days[3],
        value: -0.45,
        availableAt: fetchedAt,
        fetchedAt,
      },
    ];
    expect(
      macroEnvironment(a, days[3], days, fetchedAt).rows[0].change,
    ).toBeCloseTo(5);
  });
  it("修订不覆盖原值的可见时间，重复抓取保留首次可见", () => {
    const first = mergeObservations(
      [],
      [{ observationDate: days[1], value: 4 }],
      "2026-09-21T01:00:00Z",
    );
    const same = mergeObservations(
      first,
      [{ observationDate: days[1], value: 4 }],
      fetchedAt,
    );
    expect(same[0].availableAt).toBe(first[0].availableAt);
    const revised = mergeObservations(
      same,
      [{ observationDate: days[1], value: 5 }],
      fetchedAt,
    );
    const a = archive();
    a.series.DGS10 = revised;
    expect(
      macroEnvironment(a, days[1], days, "2026-09-22T00:00:00Z").rows[0].value,
    ).toBe(4);
    expect(macroEnvironment(a, days[1], days, fetchedAt).rows[0].value).toBe(5);
  });
  it("油金 BTC 不能反向改变利率美元环境；波动不等于内部方向", () => {
    const a = archive({ DGS10: -0.05, DGS2: -0.05, DXY: -0.5 });
    expect(macroEnvironment(a, days[3], days, fetchedAt).regime).toBe(
      "Supportive",
    );
    a.series.BTC = [];
    a.series.GOLD = [];
    a.series.WTI = [];
    expect(macroEnvironment(a, days[3], days, fetchedAt).regime).toBe(
      "Supportive",
    );
    expect(marketEngine([frame()]).state).toBe("Broad Risk-On");
  });
});
describe("不可变市场上下文", () => {
  afterEach(() => vi.restoreAllMocks());
  it("兼容 v1，并保留 v2 的完整证据；拒绝信号之后才发布的状态", async () => {
    const legacy = {
      date: days[3],
      builtAt: fetchedAt,
      regime: "Risk-On" as const,
    };
    const spy = vi.spyOn(snapshots, "readSnapshot").mockResolvedValue(legacy);
    expect(
      await marketContextBefore(Date.parse(fetchedAt) + 1, days[3]),
    ).toEqual({ date: days[3], regime: "Risk-On" });
    spy.mockResolvedValue({
      ...legacy,
      engine: marketEngine([frame()]),
      macro: macroEnvironment(archive(), days[3], days, fetchedAt),
    });
    expect(
      (await marketContextBefore(Date.parse(fetchedAt) + 1, days[3]))?.engine
        ?.version,
    ).toBe("market-state-v2");
    expect(
      await marketContextBefore(Date.parse(fetchedAt) - 1, days[3]),
    ).toBeUndefined();
    expect(
      await marketContextBefore(Date.parse(fetchedAt) + 1, days[2]),
    ).toBeUndefined();
  });
});
it("未来行情不改变历史引擎；缺细分行业不抹掉11大板块排名", () => {
  const dates = Array.from({ length: 50 }, (_, i) =>
    new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  );
  const members = Array.from({ length: 100 }, (_, i) => `S${i}`);
  const bars: Bars = new Map(
    [
      ...new Set([
        ...members,
        ...REVIEW_SECTORS.map((s) => s.symbol),
        "SPX",
        "SPY",
        "QQQ",
        "IWM",
        "VIX",
      ]),
    ].map((s, i) => [
      s,
      dates.map((date, j) => ({
        date,
        open: 100,
        high: 200,
        low: 80,
        close: 100 + j * ((i % 5) + 1),
        volume: 100,
      })),
    ]),
  );
  const run = () =>
    marketReview(
      bars,
      dates,
      dates[45],
      members,
      dates[45],
      sectorStrength(bars, dates, dates[45]),
      sectorStrength(bars, dates, dates[44]),
    );
  const before = run();
  bars.get("SPY")!.push({
    date: "2027-01-01",
    open: 100,
    high: 99999,
    low: 1,
    close: 99999,
    volume: 1,
  });
  expect(run()).toEqual(before);
  bars.delete("SMH");
  const ranks = sectorStrength(bars, dates, dates[45]);
  expect(
    ranks.filter((r) => r.group === "sector").every((r) => r.rps != null),
  ).toBe(true);
  expect(
    ranks.filter((r) => r.group === "industry").every((r) => r.rps == null),
  ).toBe(true);
  expect(run().strongSectors.total).toBe(11);
});
