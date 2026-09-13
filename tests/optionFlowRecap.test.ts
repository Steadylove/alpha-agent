import { describe, expect, it } from "vitest";

import type { GexSnapshot } from "@/lib/discord/gexCopy";
import { buildDailyFlowDigest } from "@/lib/optionFlow/digest";
import { buildDailyRecap, formatDailyRecap } from "@/lib/optionFlow/recap";
import type { OptionFlowPost } from "@/lib/optionFlow/types";

const snapshot: GexSnapshot = {
  items: [
    {
      symbol: "SPY",
      spot: 764.3,
      as_of: "2026-09-11T15:59:59",
      net_gex: -1,
      status: "偏负",
      gamma_flip: 769.7,
      call_wall: 765,
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

describe("option flow recap", () => {
  it("卖 Put 计入看涨，正文只写库里的数", () => {
    const digest = buildDailyFlowDigest(
      [
        post({
          id: "pwr",
          kind: "flow",
          postedAt: "2026-09-12T00:10:00.000Z",
          thesis: "$PWR - $23.9M Put seller (bullish)",
          legs: [{ ticker: "PWR", right: "put", strike: 760, expiry: "12/18/26", premiumUsd: 23_900_000, note: "seller" }],
        }),
        post({
          id: "meta",
          kind: "flow",
          postedAt: "2026-09-12T00:20:00.000Z",
          thesis: "$4.2 million into these $META calls",
          legs: [{ ticker: "META", right: "call", strike: 660, expiry: "09/25/26", premiumUsd: 4_200_000 }],
        }),
      ],
      snapshot,
    );
    const recap = buildDailyRecap(digest, snapshot);
    expect(recap.sellPutUsd).toBe(23_900_000);
    expect(recap.buyCallUsd).toBe(4_200_000);
    expect(recap.bullUsd).toBe(28_100_000);
    expect(recap.bearUsd).toBe(0);
    const text = formatDailyRecap(recap);
    expect(text).toContain("偏看涨");
    expect(text).toContain("PWR");
    expect(text).toContain("卖 PUT");
    expect(text).toContain("Put 墙 760");
    expect(text).toContain("未写入暗池、新闻、经济日历");
    expect(text).not.toContain("半导体");
    expect(text).not.toContain("NFP");
    expect(text).not.toContain("暗池 $");
  });
});
