import { describe, expect, it } from "vitest";

import { optionFlowConfig, shouldForward } from "@/lib/optionFlow/config";
import { shouldPublish } from "@/lib/optionFlow/publish";
import { extractCard, parsePremiumUsd } from "@/lib/optionFlow/extract";
import { mergeChartLeg, parseChartText } from "@/lib/optionFlow/parseChart";
import { parseRelayMessage } from "@/lib/optionFlow/parseDiscord";
import { emptyOptionFlow, mergeOptionFlow } from "@/lib/optionFlow/store";

describe("option flow extract", () => {
  it("金额解析不把 @3.69 或 46% 当成资金", () => {
    expect(parsePremiumUsd("$1.5M @ 3.69")).toBe(1_500_000);
    expect(parsePremiumUsd("$996K")).toBe(996_000);
    expect(parsePremiumUsd("3 million")).toBe(3_000_000);
    expect(parsePremiumUsd("4.1 million")).toBe(4_100_000);
    expect(parsePremiumUsd("46%")).toBeUndefined();
    expect(parsePremiumUsd("@ 3.69")).toBeUndefined();
  });

  it("拆 Noteworthy / OI Confirmed 名单", () => {
    const card = extractCard(
      "Noteworthy flow from Friday\n(OI Confirmed)\n\n$HOOD 145 Call (10/16) - $1.5M @ 3.69\n$SMCI 48 Call (12/18) - $996K @ 3.73",
    );
    expect(card.kind).toBe("noteworthy");
    expect(card.legs).toEqual([
      { ticker: "HOOD", strike: 145, right: "call", expiry: "10/16", premiumUsd: 1_500_000, optionPrice: 3.69 },
      { ticker: "SMCI", strike: 48, right: "call", expiry: "12/18", premiumUsd: 996_000, optionPrice: 3.73 },
    ]);
  });

  it("抽 Call buyer 和 into these calls", () => {
    expect(extractCard("$TSCO - $166K Call buyer").legs[0]).toMatchObject({
      ticker: "TSCO",
      premiumUsd: 166_000,
      right: "call",
      note: "buyer",
    });
    expect(extractCard("$NBIS - 355K Call buyer").legs[0].premiumUsd).toBe(355_000);
    expect(extractCard("$1.3 million into these $CRWV calls. 46% OTM").legs[0]).toMatchObject({
      ticker: "CRWV",
      premiumUsd: 1_300_000,
      right: "call",
    });
    expect(extractCard("$782K into these $IREN calls. $95 strike").legs[0]).toMatchObject({
      ticker: "IREN",
      strike: 95,
      premiumUsd: 782_000,
    });
    expect(extractCard("$2.3 million into these $LYFT puts").legs[0]).toMatchObject({
      ticker: "LYFT",
      right: "put",
      premiumUsd: 2_300_000,
    });
  });

  it("认 $TICKER $strike strike 和月份 / 两周到期，并允许转发", () => {
    const orcl = extractCard("$3.5 million into these $ORCL $230 strike March calls. 46% OTM.");
    expect(orcl.legs[0]).toMatchObject({
      ticker: "ORCL",
      strike: 230,
      right: "call",
      expiry: "March",
      premiumUsd: 3_500_000,
    });
    expect(shouldForward(orcl, { minPremiumUsd: 0, dropAds: true, dropPaid: true })).toBe(true);

    const meta = extractCard("$4.2 million into these $META $660 strike calls expiring in two weeks");
    expect(meta.legs[0]).toMatchObject({
      ticker: "META",
      strike: 660,
      expiry: "two weeks",
      premiumUsd: 4_200_000,
    });
    expect(shouldForward(meta, { minPremiumUsd: 0, dropAds: true, dropPaid: true })).toBe(true);

    const avgo = extractCard("$14 million into these $AVGO $650 strike December call LEAPs. 78% OTM.");
    expect(avgo.legs[0]).toMatchObject({
      ticker: "AVGO",
      strike: 650,
      expiry: "December",
      right: "call",
      premiumUsd: 14_000_000,
    });
    expect(shouldForward(avgo, { minPremiumUsd: 0, dropAds: true, dropPaid: true })).toBe(true);
  });

  it("拆 $TICKER $strike call (Sept 25) 这种确认名单", () => {
    const card = extractCard(
      "Noteworthy flow today\n$ASTS $65 call (Sept 25) - $1M @ 1.6\n$ORCL $230 call (Mar '27) - $3.4M @ 8.7",
    );
    expect(card.kind).toBe("noteworthy");
    expect(card.legs).toEqual([
      { ticker: "ASTS", strike: 65, right: "call", expiry: "Sept 25", premiumUsd: 1_000_000, optionPrice: 1.6 },
      { ticker: "ORCL", strike: 230, right: "call", expiry: "Mar '27", premiumUsd: 3_400_000, optionPrice: 8.7 },
    ]);
    expect(shouldForward(card, { minPremiumUsd: 0, dropAds: true, dropPaid: true })).toBe(true);
  });

  it("付费墙和广告能分出来", () => {
    expect(extractCard("🔒 Seems like posted a tweet for paid guys\n\nHeatmaps").kind).toBe("paid");
    expect(extractCard("Great week to get funded! 70% off any eval account").kind).toBe("ad");
    expect(extractCard("$SPY $3 BILLION+ Put Wall @ 760").kind).toBe("gex");
  });

  it("门槛可配，默认 0 不拦金额，缺行权到期不转", () => {
    const post = { kind: "flow" as const, legs: [{ ticker: "LYFT", strike: 13, expiry: "03/19/27", premiumUsd: 158_000 }] };
    expect(shouldForward(post, { minPremiumUsd: 0, dropAds: true, dropPaid: true })).toBe(true);
    expect(shouldForward(post, { minPremiumUsd: 200_000, dropAds: true, dropPaid: true })).toBe(false);
    expect(shouldForward({ kind: "flow", legs: [{ ticker: "LYFT", premiumUsd: 2e6 }] }, { minPremiumUsd: 0, dropAds: true, dropPaid: true })).toBe(false);
    expect(shouldForward({ kind: "paid", legs: [{ ticker: "X", strike: 1, expiry: "1/1/27", premiumUsd: 1e6 }] }, { minPremiumUsd: 0, dropAds: true, dropPaid: true })).toBe(false);
    expect(shouldForward({ kind: "ad", legs: [] }, { minPremiumUsd: 0, dropAds: true, dropPaid: true })).toBe(false);
    expect(shouldPublish({ ...post, id: "1", postedAt: "", ingestedAt: "", thesis: "", imageUrls: [], imageProxyUrls: [], rawText: "" }, { minPremiumUsd: 0, dropAds: true, dropPaid: true, channelId: "c" })).toBe(true);
    expect(shouldPublish({ ...post, id: "1", postedAt: "", ingestedAt: "", thesis: "", imageUrls: [], imageProxyUrls: [], rawText: "", publishedAt: "2026-09-10T00:00:00Z" }, { minPremiumUsd: 0, dropAds: true, dropPaid: true, channelId: "c" })).toBe(false);
  });

  it("读环境变量门槛", () => {
    const prev = process.env.OPTION_FLOW_MIN_PREMIUM_USD;
    try {
      process.env.OPTION_FLOW_MIN_PREMIUM_USD = "500000";
      expect(optionFlowConfig().minPremiumUsd).toBe(500_000);
    } finally {
      if (prev === undefined) delete process.env.OPTION_FLOW_MIN_PREMIUM_USD;
      else process.env.OPTION_FLOW_MIN_PREMIUM_USD = prev;
    }
  });

  it("X-Relay embed 抽出 handle 和推文，忽略 Token Detected", () => {
    const post = parseRelayMessage({
      id: "1",
      timestamp: "2026-09-08T13:07:19.000Z",
      author: { username: "X-Relay", bot: true },
      webhook_id: "x",
      embeds: [
        {
          description: "$TSCO - $166K Call buyer",
          url: "https://x.com/FL0WG0D/status/2097330577460371805",
          author: { name: "Flow God ✔️ (@FL0WG0D)" },
          image: { url: "https://pbs.twimg.com/media/x.jpg" },
          fields: [{ name: "🪙 Token Detected", value: "crypto junk" }],
        },
      ],
    });
    expect(post).toMatchObject({
      id: "1",
      handle: "FL0WG0D",
      tweetId: "2097330577460371805",
      kind: "flow",
      rawText: "$TSCO - $166K Call buyer",
    });
    expect(post?.imageUrls).toEqual(["https://pbs.twimg.com/media/x.jpg"]);
    expect(post?.imageProxyUrls).toEqual([]);
    expect(post?.rawText).not.toContain("crypto");
  });

  it("从 Bullflow 图头读行权价和到期", () => {
    const live = parseChartText(
      "GOOGL 355 Call $2.80\nExp. 10/02/26 4 +$0.05 (+1.82%)\nPrem: $3.0M OTM: 7.1% Multi: 0%",
    );
    expect(live).toMatchObject({ ticker: "GOOGL", strike: 355, right: "call", expiry: "10/02/26", premiumUsd: 3_000_000 });
    const chart = parseChartText("PLTR 190 Call\nExp. 12/17/27\nPrem: $15.8M\nOTM: 11.4%");
    expect(chart).toEqual({
      ticker: "PLTR",
      strike: 190,
      right: "call",
      expiry: "12/17/27",
      premiumUsd: 15_800_000,
      otmPct: 11.4,
    });
    expect(mergeChartLeg({ ticker: "PLTR", premiumUsd: 15_500_000, right: "call" }, chart!)).toMatchObject({
      strike: 190,
      expiry: "12/17/27",
      premiumUsd: 15_500_000,
      otmPct: 11.4,
    });
  });

  it("按消息 id 去重合并", () => {
    const first = mergeOptionFlow(emptyOptionFlow("c"), [
      { id: "1", postedAt: "2026-09-08T00:00:00Z", ingestedAt: "", kind: "flow", thesis: "a", legs: [], imageUrls: [], imageProxyUrls: [], rawText: "a" },
    ], "c");
    const next = mergeOptionFlow(first, [
      { id: "1", postedAt: "2026-09-08T00:00:00Z", ingestedAt: "", kind: "flow", thesis: "b", legs: [], imageUrls: [], imageProxyUrls: [], rawText: "b" },
      { id: "2", postedAt: "2026-09-08T01:00:00Z", ingestedAt: "", kind: "flow", thesis: "c", legs: [], imageUrls: [], imageProxyUrls: [], rawText: "c" },
    ], "c");
    expect(next.posts.map((p) => p.id)).toEqual(["1", "2"]);
    expect(next.posts[0].thesis).toBe("b");
    expect(next.lastMessageId).toBe("2");
  });

  it("合并时保留已转发标记", () => {
    const first = mergeOptionFlow(emptyOptionFlow("c"), [
      { id: "1", postedAt: "2026-09-08T00:00:00Z", ingestedAt: "", kind: "flow", thesis: "a", legs: [], imageUrls: [], imageProxyUrls: [], rawText: "a", publishedAt: "2026-09-10T00:00:00Z" },
    ], "c");
    const next = mergeOptionFlow(first, [
      { id: "1", postedAt: "2026-09-08T00:00:00Z", ingestedAt: "", kind: "flow", thesis: "b", legs: [], imageUrls: [], imageProxyUrls: [], rawText: "b" },
    ], "c");
    expect(next.posts[0].publishedAt).toBe("2026-09-10T00:00:00Z");
  });
});
