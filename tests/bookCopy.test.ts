import { cashBookSvg } from "@/lib/discord/bookCardImage";
import { renderCashBook } from "@/lib/discord/bookCopy";
import { describe, expect, it } from "vitest";

const sample = {
  asOf: "2026-08-21T17:30",
  since: "2021-08-24",
  label: "4 小时",
  exposurePct: 75,
  equity: 1.12,
  rows: [{ symbol: "NVDA", floatPnlPct: 6.2, entryPrice: 170, weightPct: 12.5, rps: 79 }],
};

describe("cash book copy", () => {
  it("每行写该股相对大池分位，不写门槛、RPS、一买二买", () => {
    const msg = renderCashBook(sample);
    const text = JSON.stringify(msg);
    expect(msg.content).toContain("记账自 2021-08-24");
    expect(text).toContain("强于 79%");
    expect(text).toContain("累计盈利");
    expect(text).toContain("+12.0%");
    expect(text).not.toContain("权益");
    expect(text).not.toContain("强于 30%");
    expect(text).not.toMatch(/RPS|一买|二买/);
  });
});

describe("cash book card", () => {
  it("强度列是每股分位，表头不写门槛", () => {
    const svg = cashBookSvg(sample);
    expect(svg).toContain("记账自 2021-08-24");
    expect(svg).toContain("截至 2026-08-21 17:30");
    expect(svg).toContain("强度");
    expect(svg).toContain("强于 79%");
    expect(svg).toContain("NVDA");
    expect(svg).toContain("+6.2%");
    expect(svg).toContain("170.00");
    expect(svg).toContain("12.5%");
    expect(svg).toContain("累计盈利");
    expect(svg).toContain("+12.0%");
    expect(svg).not.toContain("权益");
    expect(svg).not.toContain("强于 30%");
    expect(svg).not.toMatch(/RPS|一买|二买|强度超过/);
  });
});
