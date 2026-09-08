import {
  gexBriefFromSnapshot,
  gexBriefPushBody,
  gexCardWithSummary,
  marketClose,
  marketHeadline,
  marketLevels,
  marketStateFromSnapshot,
  marketStatePushBody,
} from "@/lib/discord/marketStateCopy";
import { describe, expect, it } from "vitest";

const snapshot = {
  dte: "0-45d",
  items: [
    {
      symbol: "SPX",
      spot: 7718.6,
      as_of: "2026-09-04T16:14:59",
      net_gex: 12206389791,
      status: "偏正",
      gamma_flip: 7701.576,
      call_wall: 7800,
      put_wall: 7700,
    },
    {
      symbol: "SPY",
      spot: 770.19,
      net_gex: -4103941798,
      status: "偏负",
      gamma_flip: 771.901,
      call_wall: 775,
      put_wall: 760,
    },
    {
      symbol: "QQQ",
      spot: 718.96,
      net_gex: -1220844714,
      status: "临界",
      gamma_flip: 720.024,
      call_wall: 720,
      put_wall: 700,
    },
  ],
};

describe("market state copy", () => {
  it("SPX 正结构写分界和磁铁，不写买卖", () => {
    const view = marketStateFromSnapshot(snapshot);
    expect(view?.title).toBe("SPX 关键位与资金结构");
    expect(view?.headline).toContain("7702 是多空分界");
    expect(view?.headline).toContain("7800 是最大磁铁档");
    expect(view?.close).toContain("QQQ 贴 Flip");
    expect(view?.close).toContain("SPY 近月净 GEX 为负");
    expect(view?.close).not.toContain("已贴边或翻到负侧");
    expect(view?.close).toContain("截面描述，不是操作计划");
    expect(view?.levels.map((row) => row.level)).toEqual(["7800", "7719", "7702", "7700"]);
    expect(JSON.stringify(view)).not.toMatch(/买|卖|追|加仓|做多|做空|建议|上行看|失守/);
  });

  it("同伴按实际状态分组", () => {
    const close = marketClose(snapshot.items[0], [
      { ...snapshot.items[1], net_gex: 1e9, status: "偏正" },
      snapshot.items[2],
    ]);
    expect(close).toContain("SPY 仍在正侧");
    expect(close).toContain("QQQ 贴 Flip");
    expect(close).not.toContain("已贴边或翻到负侧");
  });

  it("关键位按价从高到低，负 GEX 不写正结构磁铁", () => {
    const levels = marketLevels({
      symbol: "SPX",
      spot: 7600,
      net_gex: -1e9,
      status: "偏负",
      gamma_flip: 7700,
      call_wall: 7800,
      put_wall: 7500,
    });
    expect(levels.map((row) => row.level)).toEqual(["7800", "7700", "7600", "7500"]);
    expect(levels.find((row) => row.role.startsWith("Call"))?.meaning).not.toContain("正结构");
  });

  it("贴 Flip 写成结构变薄", () => {
    expect(
      marketHeadline({
        symbol: "QQQ",
        spot: 718.96,
        net_gex: -1e9,
        status: "临界",
        gamma_flip: 720.024,
        call_wall: 720,
        put_wall: 700,
      }),
    ).toBe("现价贴近 Flip 720，正负结构变薄。");
  });

  it("推送体带结构图文件名", () => {
    const body = marketStatePushBody(snapshot);
    expect(body.filename).toBe("market-state.png");
    expect(body.content).toContain("结构");
  });

  it("GEX 图底栏带结构总结", () => {
    const view = gexCardWithSummary(snapshot);
    expect(view.headline).toContain("7702 是多空分界");
    expect(view.note).toContain("截面描述，不是操作计划");
  });

  it("合成图带表和关键位", () => {
    const view = gexBriefFromSnapshot(snapshot);
    expect(view.gex.rows.map((row) => row.symbol)).toEqual(["SPX", "SPY", "QQQ"]);
    expect(view.state.title).toBe("SPX 关键位与资金结构");
    expect(view.state.levels).toHaveLength(4);
    expect(gexBriefPushBody(snapshot).filename).toBe("gex.png");
    expect(JSON.stringify(view)).not.toMatch(/4H|2H|买|卖|追|加仓/);
  });
});
