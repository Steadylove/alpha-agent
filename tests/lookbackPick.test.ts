import { describe, expect, it } from "vitest";

import { bookContrib, clampPickSize, openBookPct, pickByRank } from "@/lib/fund/lookbackPickLogic";

describe("lookback pick", () => {
  it("未平仓 12.5% 仓涨 20% 只贡献约 2 个净值点", () => {
    expect(openBookPct(12.5, 20)).toBeCloseTo(2.083, 2);
  });

  it("按账本持仓贡献排序，未平仓浮盈按仓位折到净值", () => {
    expect(
      bookContrib(
        [
          { symbol: "AAA", pct: 10 },
          { symbol: "AAA", pct: 5 },
          { symbol: "BBB", pct: 8 },
        ],
        [{ symbol: "CCC", floatPnlPct: 20, weightPct: 12.5 }],
      ).map((r) => r.ticker),
    ).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("两边名次相加取前 N", () => {
    expect(
      pickByRank(
        [
          { ticker: "AAA", eq: 2, n: 1 },
          { ticker: "BBB", eq: 1.5, n: 1 },
        ],
        [
          { ticker: "BBB", eq: 3, n: 1 },
          { ticker: "CCC", eq: 1.2, n: 1 },
        ],
        2,
      ),
    ).toEqual(["BBB", "AAA"]);
  });

  it("只数必须是 1–120 的整数", () => {
    expect(clampPickSize(40)).toBe(40);
    expect(clampPickSize(0)).toBeNull();
    expect(clampPickSize(121)).toBeNull();
  });
});
