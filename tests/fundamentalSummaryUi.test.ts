import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FundamentalSummary } from "@/components/fundamental/FundamentalSummary";
import { FundamentalDrawer } from "@/components/fundamental/FundamentalDrawer";
import { MantineProvider } from "@mantine/core";
import type { FundamentalSummaryData } from "@/lib/fundamental/types";

const example = (): FundamentalSummaryData => ({ symbol: "ACME", status: "ready", reasons: [], checkedAt: "2026-10-03T12:00:00Z", publishedAt: "2026-10-02T12:00:00Z",
  method: "Forward P/E", quote: { price: 100, observedAt: "2026-10-03T12:00:00Z" }, currency: "USD",
  sixMonth: { weightedTarget: 90, rangeLow: 70, rangeHigh: 110 }, twelveMonth: { weightedTarget: 120, rangeLow: 80, rangeHigh: 150 } });
const render = (data?: FundamentalSummaryData) => renderToStaticMarkup(createElement(FundamentalSummary, { symbol: "ACME", data }));

describe("website fundamental summary", () => {
  it("shows separate horizons, dated quote basis and latest-not-historical context", () => {
    const html = render(example());
    for (const expected of ["6M", "12M", "$90.00", "$120.00", "-10.0%", "+20.0%", "$70.00 – $110.00", "$80.00 – $150.00", "2026-10-03 08:00 ET", "非实时", "最新估值不代表买点当时已知", "2H / 4H 共用", "Forward P/E"]) expect(html).toContain(expected);
  });
  it("handles missing quotes, stale targets, failed reads and demo labeling explicitly", () => {
    const data = example(); data.quote = null; data.status = "stale"; data.demo = true;
    const html = render(data);
    expect(html).toContain("旧版参考"); expect(html).toContain("空间 —"); expect(html).not.toContain("+20.0%");
    expect(html).toContain("测试数据"); expect(html).toContain("$120.00");
    data.status = "error";
    expect(render(data)).not.toContain("$120.00"); expect(render(data)).toContain("不影响信号和账本");
    expect(render()).toContain("尚无留档");
  });
  it("preserves independent same-symbol history links and visibly refuses unknown instants", () => {
    const html = renderToStaticMarkup(createElement(FundamentalSummary, { symbol: "ACME", data: example(), entries: [
      { label: "2H 信号时估值", entryAt: "2026-09-25T17:30:00Z" },
      { label: "4H 模拟入场时估值", entryAt: "2026-09-24T13:30:00Z" },
      { label: "旧记录", entryAt: null },
    ] }));
    expect(html).toContain("entryAt=2026-09-25T17%3A30%3A00.000Z#entry-valuation");
    expect(html).toContain("entryAt=2026-09-24T13%3A30%3A00.000Z#entry-valuation");
    expect(html).toContain("旧记录：准确时间未留档");
  });
  it("drawer full-page navigation keeps the selected historical context", () => {
    const html = renderToStaticMarkup(createElement(MantineProvider, {}, createElement(FundamentalDrawer, {
      symbol: "ACME", entryAt: "2026-09-25T17:30:00Z", onClose: () => undefined,
    })));
    expect(html).toContain("entryAt=2026-09-25T17%3A30%3A00.000Z#entry-valuation");
    expect(html).toContain("正在读取 ACME");
  });
});
