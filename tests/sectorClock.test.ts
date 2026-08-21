import {
  type SectorClockInput,
  computeSectorClockSeries,
  sectorStanding,
} from "@/lib/scoring/sectorClock";
import { type SectorClockId, SECTOR_UNIVERSE, mapSectorToClock } from "@/lib/scoring/sectorUniverse";
import { describe, expect, it } from "vitest";

const IDS = SECTOR_UNIVERSE.map((s) => s.id);
const N = 200;

const ramp = (dailyPct: number, len = N) =>
  Array.from({ length: len }, (_, i) => 100 * (1 + dailyPct / 100) ** i);

/** 除指定档位外全部走平的行情。 */
function makeInput(overrides: Partial<Record<SectorClockId, number[]>>): SectorClockInput {
  const sectorCloses = {} as Record<SectorClockId, (number | null)[]>;
  for (const id of IDS) {
    sectorCloses[id] = overrides[id] ?? new Array(N).fill(100);
  }
  return { sectorCloses, benchmarkCloses: new Array(N).fill(100) };
}

const lastDay = (input: SectorClockInput) => computeSectorClockSeries(input).at(-1)!;

/**
 * 先跌后涨的 V 形。资金回流的判定要求 63 日比率低而 21 日超额高，
 * 两个窗口重叠 21 根，单纯「横盘后拉升」无法同时满足，必须先把 63 日基数抬高。
 */
function vShape(turn: number, downPct: number, upPct: number, len = N): number[] {
  const out: number[] = [];
  let v = 100;
  for (let i = 0; i < len; i += 1) {
    v *= 1 + (i < turn ? downPct : upPct) / 100;
    out.push(v);
  }
  return out;
}

describe("SLS 分数", () => {
  it("走平的板块比率为 1", () => {
    expect(lastDay(makeInput({})).scores.TECH).toBeCloseTo(1, 10);
  });

  it("上涨的板块比率大于 1，下跌小于 1", () => {
    const day = lastDay(makeInput({ TECH: ramp(0.3), ENERGY: ramp(-0.3) }));
    expect(day.scores.TECH).toBeGreaterThan(1);
    expect(day.scores.ENERGY).toBeLessThan(1);
  });

  it("取的是滞后一根的 63 日比率，不含当日收盘价", () => {
    const closes = ramp(0.3);
    const day = lastDay(makeInput({ TECH: closes }));
    // c0 = closes[198]，c63 = closes[135]
    expect(day.scores.TECH).toBeCloseTo(closes[198] / closes[135], 10);
  });

  it("历史不足 64 根时记 0", () => {
    const days = computeSectorClockSeries(makeInput({}));
    expect(days[63].scores.TECH).toBe(0);
    expect(days[64].scores.TECH).toBeCloseTo(1, 10);
  });

  it("板块未上市（全 null）时记 0，排名垫底", () => {
    const sectorCloses = {} as Record<SectorClockId, (number | null)[]>;
    for (const id of IDS) sectorCloses[id] = new Array(N).fill(100);
    sectorCloses.COMM = new Array(N).fill(null);
    const day = computeSectorClockSeries({
      sectorCloses,
      benchmarkCloses: new Array(N).fill(100),
    }).at(-1)!;

    expect(day.scores.COMM).toBe(0);
    expect(sectorStanding(day, "COMM").rank).toBe(11);
  });
});

describe("21 日超额", () => {
  it("与基准同步时超额为 0", () => {
    expect(lastDay(makeInput({})).mom21.TECH).toBeCloseTo(0, 10);
  });

  it("跑赢基准为正，跑输为负", () => {
    const sectorCloses = {} as Record<SectorClockId, (number | null)[]>;
    for (const id of IDS) sectorCloses[id] = new Array(N).fill(100);
    sectorCloses.TECH = ramp(0.3);
    sectorCloses.ENERGY = ramp(-0.3);

    const day = computeSectorClockSeries({
      sectorCloses,
      benchmarkCloses: ramp(0.1),
    }).at(-1)!;

    expect(day.mom21.TECH).toBeGreaterThan(0);
    expect(day.mom21.ENERGY).toBeLessThan(0);
  });
});

describe("领涨主线 top3", () => {
  it("按 SLS 降序取前三", () => {
    const day = lastDay(
      makeInput({
        TECH: ramp(0.4),
        FIN: ramp(0.3),
        HEALTH: ramp(0.2),
        DISC: ramp(0.1),
      }),
    );
    expect(day.top3).toEqual(["TECH", "FIN", "HEALTH"]);
  });

  it("恒为三个且互不重复", () => {
    const day = lastDay(makeInput({ TECH: ramp(0.4) }));
    expect(day.top3).toHaveLength(3);
    expect(new Set(day.top3).size).toBe(3);
  });

  it("全部并列时按数组下标顺序取前三（Pine 严格大于比较的后果）", () => {
    expect(lastDay(makeInput({})).top3).toEqual([IDS[0], IDS[1], IDS[2]]);
  });
});

describe("资金回流候选", () => {
  it("涨幅落后但 21 日超额转正时入选", () => {
    const sectorCloses = {} as Record<SectorClockId, (number | null)[]>;
    for (const id of IDS) sectorCloses[id] = ramp(0.3);
    sectorCloses.ENERGY = vShape(177, -0.1, 0.2);

    const day = computeSectorClockSeries({
      sectorCloses,
      benchmarkCloses: new Array(N).fill(100),
    }).at(-1)!;

    expect(day.scores.ENERGY).toBeLessThan(1.05);
    expect(day.mom21.ENERGY).toBeGreaterThan(0.01);
    expect(day.bottoming).toEqual(["ENERGY"]);
  });

  it("涨幅已经领先的板块不算回流", () => {
    const day = lastDay(makeInput({ TECH: ramp(0.4) }));
    expect(day.bottoming).not.toContain("TECH");
  });

  it("无人入选时给出 21 日超额最高者作兜底", () => {
    const sectorCloses = {} as Record<SectorClockId, (number | null)[]>;
    for (const id of IDS) sectorCloses[id] = ramp(0.3);
    sectorCloses.FIN = ramp(0.5);

    const day = computeSectorClockSeries({
      sectorCloses,
      benchmarkCloses: ramp(0.3),
    }).at(-1)!;

    expect(day.bottoming).toHaveLength(0);
    expect(day.rotatingLeader).toBe("FIN");
  });
});

describe("个股所属行业站位", () => {
  const day = lastDay(
    makeInput({
      TECH: ramp(0.4),
      FIN: ramp(0.35),
      HEALTH: ramp(0.3),
      DISC: ramp(0.25),
      COMM: ramp(0.2),
      INDU: ramp(0.15),
      STAPLES: ramp(-0.1),
      ENERGY: ramp(-0.2),
    }),
  );

  it("前三名判为领涨主线", () => {
    expect(sectorStanding(day, "TECH")).toMatchObject({ rank: 1, status: "leader" });
    expect(sectorStanding(day, "HEALTH")).toMatchObject({ rank: 3, status: "leader" });
  });

  it("第 4~6 名判为中性轮动", () => {
    expect(sectorStanding(day, "DISC")).toMatchObject({ rank: 4, status: "neutral" });
  });

  it("第 7 名之后判为资金流出", () => {
    expect(sectorStanding(day, "ENERGY").status).toBe("outflow");
    expect(sectorStanding(day, "ENERGY").rank).toBeGreaterThan(6);
  });

  it("排名并列时共享名次（Pine 用 count(更大者)+1）", () => {
    const flat = lastDay(makeInput({}));
    for (const id of IDS) expect(sectorStanding(flat, id).rank).toBe(1);
  });

  it("涨幅落后但超额转正时越过名次判为潜伏筑底", () => {
    const sectorCloses = {} as Record<SectorClockId, (number | null)[]>;
    for (const id of IDS) sectorCloses[id] = ramp(0.4);
    sectorCloses.ENERGY = vShape(177, -0.1, 0.2);

    const d = computeSectorClockSeries({
      sectorCloses,
      benchmarkCloses: new Array(N).fill(100),
    }).at(-1)!;

    const standing = sectorStanding(d, "ENERGY");
    expect(standing.rank).toBeGreaterThan(3);
    expect(standing.sls).toBeLessThan(1.02);
    expect(standing.mom21).toBeGreaterThan(0.02);
    expect(standing.status).toBe("bottoming");
  });
});

describe("入参校验", () => {
  it("行业序列与基准长度不一致时抛错", () => {
    const input = makeInput({});
    input.sectorCloses.TECH = new Array(N - 1).fill(100);
    expect(() => computeSectorClockSeries(input)).toThrow(/长度不一致/);
  });
});

describe("行业名映射", () => {
  it("覆盖 FMP 实际返回的全部 8 类行业名", () => {
    expect(mapSectorToClock("Technology")).toBe("TECH");
    expect(mapSectorToClock("Financial Services")).toBe("FIN");
    expect(mapSectorToClock("Healthcare")).toBe("HEALTH");
    expect(mapSectorToClock("Consumer Cyclical")).toBe("DISC");
    expect(mapSectorToClock("Communication Services")).toBe("COMM");
    expect(mapSectorToClock("Industrials")).toBe("INDU");
    expect(mapSectorToClock("Consumer Defensive")).toBe("STAPLES");
    expect(mapSectorToClock("Energy")).toBe("ENERGY");
    expect(mapSectorToClock("Utilities")).toBe("UTIL");
    expect(mapSectorToClock("Basic Materials")).toBe("MATERIAL");
    expect(mapSectorToClock("Real Estate")).toBe("REIT");
  });

  it("判定顺序保证「Consumer Defensive」不会被可选消费截胡", () => {
    expect(mapSectorToClock("Consumer Defensive")).toBe("STAPLES");
    expect(mapSectorToClock("Consumer Cyclical")).toBe("DISC");
  });

  it("未识别与空值都兜底到信息科技（Pine 原样）", () => {
    expect(mapSectorToClock("Something Unknown")).toBe("TECH");
    expect(mapSectorToClock(null)).toBe("TECH");
    expect(mapSectorToClock(undefined)).toBe("TECH");
  });
});
