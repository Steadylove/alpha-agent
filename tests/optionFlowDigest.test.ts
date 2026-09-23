import { describe, expect, it } from "vitest";

import type { GexSnapshot } from "@/lib/discord/gexCopy";
import { normalizeExpiry } from "@/lib/optionFlow/expiry";
import {
  biasLabel,
  buildDailyFlowDigest,
  hasDigestContent,
  isUsefulNote,
  sessionDayFromSnapshot,
  spyWalls,
} from "@/lib/optionFlow/digest";
import type { OptionFlowPost } from "@/lib/optionFlow/types";

const snapshot: GexSnapshot = {
  items: [
    {
      symbol: "SPX",
      spot: 7718.6,
      as_of: "2026-09-11T16:14:59",
      net_gex: 1,
      status: "偏正",
      gamma_flip: 7701,
      call_wall: 7800,
      put_wall: 7700,
    },
    {
      symbol: "SPY",
      spot: 770.19,
      net_gex: -1,
      status: "偏负",
      gamma_flip: 771.9,
      call_wall: 775,
      put_wall: 760,
    },
  ],
};

function post(partial: Partial<OptionFlowPost> & Pick<OptionFlowPost, "id" | "kind" | "postedAt" | "legs">): OptionFlowPost {
  return {
    ingestedAt: partial.postedAt,
    thesis: "",
    imageUrls: [],
    imageProxyUrls: [],
    rawText: "",
    handle: "FL0WG0D",
    ...partial,
  };
}

describe("option flow digest", () => {
  it("会话日用 GEX as_of 的日历日，墙只用 SPY", () => {
    expect(sessionDayFromSnapshot(snapshot)).toBe("2026-09-11");
    expect(spyWalls(snapshot)).toEqual({
      symbol: "SPY",
      spot: "770.2",
      flip: "771.9",
      putWall: "760",
      callWall: "775",
    });
    expect(spyWalls({ items: [snapshot.items[0]] })).toBeNull();
  });

  it("不明确的买卖方向不推断，汇总复述不算新交易", () => {
    const view = buildDailyFlowDigest(
      [
        post({
          id: "1",
          kind: "flow",
          postedAt: "2026-09-11T14:10:00.000Z",
          thesis: "$3.5 million into these $ORCL $230 strike March calls.",
          legs: [{ ticker: "ORCL", right: "call", strike: 230, expiry: "March", premiumUsd: 3_500_000 }],
        }),
        post({
          id: "2",
          kind: "flow",
          postedAt: "2026-09-11T15:00:00.000Z",
          thesis: "$2.3 million into these $LYFT puts",
          legs: [{ ticker: "LYFT", right: "put", strike: 12, expiry: "10/16", premiumUsd: 2_300_000 }],
        }),
        post({
          id: "3",
          kind: "flow",
          postedAt: "2026-09-10T20:00:00.000Z",
          thesis: "隔日不应进日结",
          legs: [{ ticker: "AAPL", right: "call", strike: 250, expiry: "10/16", premiumUsd: 9_000_000 }],
        }),
        post({
          id: "4",
          kind: "noteworthy",
          postedAt: "2026-09-11T16:00:00.000Z",
          thesis: "Noteworthy flow from Friday",
          legs: [{ ticker: "HOOD", right: "call", strike: 145, expiry: "10/16", premiumUsd: 1_500_000 }],
        }),
      ],
      snapshot,
    );
    expect(view.day).toBe("2026-09-11");
    expect(view.title).toBe("期权流 · 9月11日");
    expect(view.bias).toBe("none");
    expect(biasLabel(view)).toBe("暂无可分类方向金额");
    expect(view.bullUsd).toBe(0);
    expect(view.bearUsd).toBe(0);
    expect(view.putUsd).toBe(2_300_000);
    expect(view.legs.map((leg) => leg.ticker)).toEqual(["ORCL", "LYFT"]);
    expect(view.notes).toEqual([]);
  });

  it("盘前盘后同一日历日也不进日结", () => {
    const view = buildDailyFlowDigest(
      [
        post({
          id: "rth",
          kind: "flow",
          postedAt: "2026-09-11T14:10:00.000Z",
          legs: [{ ticker: "ORCL", right: "call", strike: 230, expiry: "March", premiumUsd: 3_500_000 }],
        }),
        post({
          id: "pre",
          kind: "flow",
          postedAt: "2026-09-11T13:00:00.000Z",
          legs: [{ ticker: "AAPL", right: "call", strike: 250, expiry: "10/16", premiumUsd: 9_000_000 }],
        }),
        post({
          id: "after",
          kind: "flow",
          postedAt: "2026-09-11T21:00:00.000Z",
          legs: [{ ticker: "NVDA", right: "put", strike: 180, expiry: "10/16", premiumUsd: 8_000_000 }],
        }),
      ],
      snapshot,
    );
    expect(view.legs.map((leg) => leg.ticker)).toEqual(["ORCL"]);
  });

  it("没有详细备注就空着，有评论才留下", () => {
    expect(isUsefulNote("$3.5 million into these $ORCL $230 strike March calls.")).toBe(false);
    expect(isUsefulNote("$TSCO - $166K Call buyer")).toBe(false);
    expect(isUsefulNote("Noteworthy flow from Friday")).toBe(false);
    expect(isUsefulNote("Are meme stocks back in play")).toBe(true);
    expect(isUsefulNote("Massive $14 million into these $AVGO $650 strike December call LEAPs.")).toBe(false);
    expect(isUsefulNote("$SPY already has $1.1 BILLION worth of sig Dark Pool prints @ 762.26")).toBe(false);
    expect(isUsefulNote("Volume dying out. 765 strongest node")).toBe(true);
    expect(isUsefulNote("765 strongest node")).toBe(false);
    const view = buildDailyFlowDigest(
      [
        post({
          id: "1",
          kind: "flow",
          postedAt: "2026-09-11T14:10:00.000Z",
          thesis: "$1.3 million into these $HUT calls.",
          legs: [{ ticker: "HUT", right: "call", strike: 40, expiry: "next week", premiumUsd: 1_300_000 }],
        }),
        post({
          id: "2",
          kind: "flow",
          postedAt: "2026-09-11T14:20:00.000Z",
          thesis: "Are meme stocks back in play",
          legs: [{ ticker: "HUT", right: "call", strike: 45, expiry: "next week", premiumUsd: 800_000 }],
        }),
      ],
      snapshot,
    );
    expect(view.notes).toEqual([{ ticker: "HUT", text: "Are meme stocks back in play" }]);
  });

  it("没写清行权价或到期日的单不进日结", () => {
    const view = buildDailyFlowDigest(
      [
        post({
          id: "dp",
          kind: "flow",
          postedAt: "2026-09-11T14:10:00.000Z",
          thesis: "$SPY already has $1.1 BILLION worth of sig Dark Pool prints",
          legs: [{ ticker: "SPY", premiumUsd: 1_100_000_000 }],
        }),
        post({
          id: "bare",
          kind: "flow",
          postedAt: "2026-09-11T14:20:00.000Z",
          thesis: "$2 million into these $GOOGL calls",
          legs: [{ ticker: "GOOGL", right: "call", premiumUsd: 2_000_000 }],
        }),
      ],
      snapshot,
    );
    expect(view.legs).toEqual([]);
    expect(view.callUsd).toBe(0);
    expect(view.bullUsd).toBe(0);
  });

  it("卖 Put 算看涨，卖 Call 算看跌", () => {
    const view = buildDailyFlowDigest(
      [
        post({
          id: "pwr",
          kind: "flow",
          postedAt: "2026-09-11T14:10:00.000Z",
          thesis: "$PWR - $23.9M Put seller (bullish)",
          legs: [{ ticker: "PWR", right: "put", strike: 760, expiry: "12/18/26", premiumUsd: 23_900_000, note: "seller" }],
        }),
        post({
          id: "meta",
          kind: "flow",
          postedAt: "2026-09-11T14:20:00.000Z",
          thesis: "$4.2 million into these $META $660 strike calls",
          legs: [{ ticker: "META", right: "call", strike: 660, expiry: "09/25/26", premiumUsd: 4_200_000 }],
        }),
        post({
          id: "sellcall",
          kind: "flow",
          postedAt: "2026-09-11T14:30:00.000Z",
          thesis: "$AAOI - $1.6M Call seller",
          legs: [{ ticker: "AAOI", right: "call", strike: 105, expiry: "06/17/27", premiumUsd: 1_600_000, note: "seller" }],
        }),
      ],
      snapshot,
    );
    expect(view.legs.find((leg) => leg.ticker === "PWR")?.note).toBe("seller");
    expect(view.bullUsd).toBe(23_900_000);
    expect(view.bearUsd).toBe(1_600_000);
    expect(view.bias).toBe("bull");
  });

  it("研究日结保留来源到期提示，不用汇总的不同到期日覆盖原始记录", () => {
    expect(normalizeExpiry("Dec '28", "2026-09-11")).toBe("12/15/28");
    expect(normalizeExpiry("01/21/28", "2026-09-11")).toBe("01/21/28");
    expect(normalizeExpiry("Mar '27", "2026-09-11")).toBe("03/19/27");
    expect(normalizeExpiry("two weeks", "2026-09-11")).toBe("09/25/26");
    expect(normalizeExpiry("Sept 25", "2026-09-11")).toBe("09/25/26");
    expect(normalizeExpiry("March", "2026-09-11")).toBe("03/19/27");
    const view = buildDailyFlowDigest(
      [
        post({
          id: "a",
          kind: "flow",
          postedAt: "2026-09-11T14:10:00.000Z",
          tweetId: "1",
          thesis: "$14 million into these $AVGO $650 strike December call LEAPs.",
          legs: [{ ticker: "AVGO", right: "call", strike: 650, expiry: "December", premiumUsd: 14_000_000 }],
        }),
        post({
          id: "b",
          kind: "noteworthy",
          postedAt: "2026-09-11T14:20:00.000Z",
          tweetId: "2",
          thesis: "Noteworthy flow today",
          legs: [{ ticker: "AVGO", right: "call", strike: 650, expiry: "Dec '28", premiumUsd: 14_000_000 }],
        }),
      ],
      snapshot,
    );
    expect(view.legs).toEqual([
      expect.objectContaining({ ticker: "AVGO", strike: 650, expiry: "December", premiumUsd: 14_000_000 }),
    ]);
  });

  it("只汇总 FL0WG0D，其它账号不进日结", () => {
    const view = buildDailyFlowDigest(
      [
        post({
          id: "god",
          kind: "flow",
          postedAt: "2026-09-11T14:10:00.000Z",
          legs: [{ ticker: "ORCL", right: "call", strike: 230, expiry: "March", premiumUsd: 3_500_000 }],
        }),
        post({
          id: "other",
          kind: "flow",
          handle: "CheddarFlow",
          postedAt: "2026-09-11T14:20:00.000Z",
          legs: [{ ticker: "SN", right: "call", strike: 165, expiry: "09/19/26", premiumUsd: 1_300_000 }],
        }),
      ],
      snapshot,
    );
    expect(view.legs.map((leg) => leg.ticker)).toEqual(["ORCL"]);
  });

  it("指定日期时不把别日的 SPY 墙贴上去", () => {
    const view = buildDailyFlowDigest([], snapshot, "2026-09-10");
    expect(view.day).toBe("2026-09-10");
    expect(view.spy).toBeNull();
    expect(hasDigestContent(view)).toBe(false);
  });

  it("没有订单流但有 SPY 墙仍推，两边都没有才跳过", () => {
    const wallsOnly = buildDailyFlowDigest([], snapshot);
    expect(wallsOnly.legs).toEqual([]);
    expect(wallsOnly.spy?.putWall).toBe("760");
    expect(hasDigestContent(wallsOnly)).toBe(true);
    expect(hasDigestContent(buildDailyFlowDigest([], { items: [] }))).toBe(false);
  });
});
