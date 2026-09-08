import { gexCaption, gexCardFromSnapshot, gexImpact, gexPushBody, fmtLevel, netGexLabel } from "@/lib/discord/gexCopy";
import { describe, expect, it } from "vitest";

const snapshot = {
  dte: "0-45d",
  tnx: { last: 4.783999919891357 },
  items: [
    {
      symbol: "SPX",
      spot: 7718.6,
      as_of: "2026-09-04T16:14:59",
      net_gex: 12206389791.414543,
      status: "偏正",
      gamma_flip: 7701.576361501779,
      call_wall: 7800,
      put_wall: 7700,
    },
    {
      symbol: "SPY",
      spot: 770.19,
      net_gex: -4103941798.1007586,
      status: "偏负",
      gamma_flip: 771.9011078622914,
      call_wall: 775,
      put_wall: 760,
    },
    {
      symbol: "QQQ",
      spot: 718.96,
      net_gex: -1220844714.6215448,
      status: "临界",
      gamma_flip: 720.0244854487189,
      call_wall: 720,
      put_wall: 700,
    },
  ],
};

describe("gex format", () => {
  it("档位和净 GEX 跟脚本口径一致", () => {
    expect(fmtLevel(7718.6)).toBe("7719");
    expect(fmtLevel(770.19)).toBe("770.2");
    expect(fmtLevel(718.96)).toBe("719");
    expect(fmtLevel(7701.576)).toBe("7702");
    expect(fmtLevel(771.901)).toBe("771.9");
    expect(fmtLevel(720.024)).toBe("720");
    expect(netGexLabel(12206389791)).toBe("+$12.2B");
    expect(netGexLabel(-4103941798)).toBe("-$4.1B");
  });
});

describe("gex copy", () => {
  it("QQQ 贴近 Flip 写波动放大，SPX 写上行看 Call", () => {
    expect(gexImpact(snapshot.items[0])).toContain("上行看 7800");
    expect(gexImpact(snapshot.items[2])).toBe("现价贴近 Flip 720，波动易放大");
  });

  it("卡片带 10Y 总结，不写 4H/2H", () => {
    const view = gexCardFromSnapshot(snapshot);
    expect(view.asOf).toBe("2026-09-04 16:14");
    expect(view.tnx).toBe("4.78");
    expect(view.note).toContain("10Y 4.78%");
    expect(view.note).toContain("SPX 在 Flip 上方偏稳");
    expect(view.rows[0]).toMatchObject({ symbol: "SPX", spot: "7719", netGex: "+$12.2B", flip: "7702" });
    expect(gexCaption(false)).toContain("TREND-ADAPTIVE");
    expect(gexCaption(true)).toContain("（测试）");
    expect(JSON.stringify(view)).not.toMatch(/4H|2H|4 小时/);
  });
});

describe("gex push body", () => {
  it("给出发图文件名和卡片 input", () => {
    const body = gexPushBody(snapshot);
    expect(body.filename).toBe("gex.png");
    expect(body.content).toContain("GEX");
    expect(body.input.rows).toHaveLength(3);
  });
});
