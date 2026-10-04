import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FundamentalPanel } from "@/components/fundamental/FundamentalPanel";
import type { FundamentalHorizon, FundamentalPageData, FundamentalValuation } from "@/lib/fundamental/types";
import { GET } from "@/app/api/fundamental/[symbol]/route";
import { getFundamentalPage } from "@/lib/fundamental/store";

vi.mock("@/lib/runtimeConfig", () => ({ loadRuntimeConfig: vi.fn(async () => undefined) }));
vi.mock("@/lib/fundamental/store", () => ({ getFundamentalPage: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());
const published = "2026-10-03T12:00:00.000Z";
function horizon(months: 6 | 12, target: number): FundamentalHorizon {
  const targetDate = months === 6 ? "2027-04-03" : "2027-10-03";
  return { months, targetDate, earningsStart: targetDate, earningsEnd: months === 6 ? "2028-04-03" : "2028-10-03",
    bear: { eps: 4, multiple: 15, target: 60, weight: .2 }, base: { eps: 5, multiple: 20, target: 100, weight: .55 }, bull: { eps: 6, multiple: 25, target: 150, weight: .25 },
    weightedTarget: target, rangeLow: 60, rangeHigh: 150 };
}
function valuation(): FundamentalValuation {
  return { version: 1, id: "a".repeat(64), rule: "forward-peer-pe-v1", symbol: "AMD", publishedAt: published, anchorDate: "2026-10-03", validUntil: "2027-01-01T12:00:00.000Z", inputHash: "input",
    input: { version: 1, symbol: "AMD", companyName: "AMD", sector: "Technology", industry: "Semiconductor", currency: "USD", isEtf: false, isAdr: false, observedAt: published,
      quote: { price: 100, observedAt: published }, earningsBasis: "non-gaap-consensus", financials: null, estimates: [], peers: [], warnings: ["预估并非公司承诺"],
      sources: [{ id: "source", label: "公司财报", url: "https://example.com/earnings?year=2026", observedAt: published, publishedAt: "2026-10-02" }] },
    method: "Forward P/E", secondaryCheck: "Reported FCF / earnings quality", peers: [{ symbol: "NVDA", ntmEps: 5, pe: 20 }, { symbol: "INTC", ntmEps: 4, pe: 18 }, { symbol: "QCOM", ntmEps: 6, pe: 19 }],
    sixMonth: horizon(6, 90), twelveMonth: horizon(12, 120), confidence: "low", assumptions: ["同业样本倍数保持所记录口径"], updateReasons: ["前瞻盈利预测变化"], revision: null,
    analyst: { generatedAt: published, model: "deepseek", inputHash: "input", summary: { text: "盈利假设依赖前瞻估计。", sourceIds: ["source"] }, drivers: [{ text: "自由现金流为正。", sourceIds: ["source"] }], risks: [{ text: "预测可能调整。", sourceIds: ["source"] }], usage: null } };
}
function page(): FundamentalPageData {
  const current = valuation();
  return { symbol: "AMD", state: { version: 1, symbol: "AMD", checkedAt: published, nextCheckAt: "2026-10-10T12:00:00.000Z", status: "ready", reasons: [], current, latestQuote: { price: 100, observedAt: published }, eventIds: [], analystStatus: "ready" }, history: [current], atEntry: null, entryAt: null, error: null };
}
const render = (data: FundamentalPageData) => renderToStaticMarkup(createElement(FundamentalPanel, { data }));

describe("fundamental saved valuation UI", () => {
  it("shows both horizons and signed upside relative to an explicitly dated saved quote", () => {
    const html = render(page());
    expect(html).toContain("6M 情景加权目标"); expect(html).toContain("12M 情景加权目标");
    expect(html).toContain("$90.00"); expect(html).toContain("$120.00");
    expect(html).toContain("-10.0%"); expect(html).toContain("+20.0%");
    expect(html).toContain("$60.00 – $150.00"); expect(html).toContain("<dt>已保存报价</dt><dd>$100.00");
    expect(html).toContain("2026-10-03 08:00 ET"); expect(html).toContain("非实时");
    expect(html).toContain("2027-04-03 至 2028-04-03"); expect(html).toContain("2027-10-03 至 2028-10-03");
    expect(html).toContain("2H / 4H 共用此估值"); expect(html).toContain("不改变买卖信号");
    expect(html).toContain("Non-GAAP 分析师共识 EPS"); expect(html).toContain("不是实证概率");
  });

  it("keeps missing, unavailable, stale and read-error states visible without fabricating prices", () => {
    const absent = page(); absent.state = null; absent.history = [];
    const empty = render(absent);
    expect(empty).toContain("尚无估值留档"); expect(empty).not.toContain("$120.00");
    const unavailable = page(); unavailable.state!.current = null; unavailable.state!.status = "unavailable"; unavailable.state!.reasons = ["前瞻盈利数据不足"];
    expect(render(unavailable)).toContain("暂无法估值"); expect(render(unavailable)).toContain("前瞻盈利数据不足");
    const stale = page(); stale.state!.status = "stale"; stale.state!.reasons = ["来源更新失败"];
    const old = render(stale); expect(old).toContain("以下是上一版估值"); expect(old).toContain("来源更新失败"); expect(old).toContain("$120.00");
    absent.error = "secret internal response";
    expect(render(absent)).toContain("读取暂不可用"); expect(render(absent)).not.toContain("secret internal response");
  });

  it("separates historical knowledge and never substitutes a later valuation for an entry", () => {
    const data = page();
    expect(render(data)).toContain("当前目标价不能视为历史买点出现时已知");
    data.entryAt = "2026-10-02T14:00:00.000Z"; data.atEntry = valuation();
    expect(render(data)).toContain("未使用后续目标价补填"); expect(render(data)).not.toContain("入场前已发布版本");
    data.atEntry.publishedAt = "2026-10-01T14:00:00.000Z"; data.atEntry.input.quote!.price = 80;
    const html = render(data);
    expect(html).toContain("入场前已发布版本"); expect(html).toContain("不使用当前报价回填"); expect(html).toContain("+50.0%");
  });

  it("shows revision attribution, saved sources and source-based AI interpretation", () => {
    const data = page();
    data.history[0].revision = { previousId: "previous", previousTarget: 110, newTarget: 120, changePct: 9.0909, earningsContribution: 12, multipleContribution: -2 };
    const html = render(data);
    expect(html).toContain("估值修订历史"); expect(html).toContain("原目标 $110.00 → 新目标 $120.00"); expect(html).toContain("+9.1%");
    expect(html).toContain("盈利变化贡献 $12.00"); expect(html).toContain("倍数变化贡献 -$2.00");
    expect(html).toContain('href="https://example.com/earnings?year=2026"'); expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("盈利假设依赖前瞻估计。"); expect(html).toContain("预估并非公司承诺"); expect(html).toContain("前瞻盈利预测变化");
  });

  it("escapes supplied copy and does not expose unsafe or credentialed evidence URLs", () => {
    for (const url of ["javascript:alert(1)", "https://user:secret@example.com/x", "https://example.com/x?apikey=hidden"]) {
      const data = page(); data.state!.current!.input.sources[0].url = url; data.state!.current!.input.companyName = "<script>evil()</script>";
      const html = render(data);
      expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).toContain("来源链接不可用");
      expect(html).not.toContain("javascript:"); expect(html).not.toContain("user:secret"); expect(html).not.toContain("apikey=hidden");
    }
  });

  it("does not fetch or trigger generation while rendering supplied snapshots", () => {
    const fetcher = vi.fn(() => { throw new Error("No network while rendering"); }); vi.stubGlobal("fetch", fetcher);
    render(page()); expect(fetcher).not.toHaveBeenCalled();
  });

  it("puts saved price, distinct evidence/check timestamps, model confidence and peer count before disclosures", () => {
    const data = page();
    data.state!.checkedAt = "2026-10-04T13:00:00.000Z";
    data.state!.latestQuote!.observedAt = "2026-10-04T12:00:00.000Z";
    const html = render(data), folded = html.indexOf("<details");
    for (const text of ["已保存报价", "2026-10-04 08:00 ET", "最近复核", "2026-10-04 09:00 ET", "证据采集 2026-10-03 08:00 ET", "低 · V1 预设", "有效同业", "3 家", "盈利假设依赖前瞻估计。", "主要依赖", "仍有不确定"]) {
      expect(html.indexOf(text)).toBeGreaterThan(-1); expect(html.indexOf(text)).toBeLessThan(folded);
    }
    expect(html).toContain("本轮通过模型核验"); expect(html).toContain("不是统计计算的置信水平");
    expect(html).toContain('aria-label="来源 1：公司财报"');
    expect(html.match(/盈利假设依赖前瞻估计。/g)).toHaveLength(1);
  });

  it("marks demo snapshots before their numbers, while unmarked real snapshots remain unmarked", () => {
    const data = page(); data.demo = true;
    const html = render(data);
    expect(html.indexOf("测试数据 · 非真实估值结果")).toBeLessThan(html.indexOf("$100.00"));
    expect(html).toContain("不能作为真实投资研究依据");
    expect(render(page())).not.toContain("测试数据");
  });

  it("provides textual equivalents for both scenario scales and retains formula-only fallback when AI is absent", () => {
    const data = page(); data.state!.current!.analyst = null; data.state!.analystStatus = "unavailable";
    const html = render(data);
    for (const months of [6, 12]) expect(html).toContain(`aria-label="${months}M 情景价格对照"`);
    for (const label of ["Bear", "Base", "Bull", "留档价"]) expect(html).toContain(`<dt>${label}</dt>`);
    expect(html).toContain("共用刻度 · 非价格路径"); expect(html).toContain("本轮 AI 解读未成功");
    expect(html).toContain("3 家有效同业"); expect(html).toContain("目标日期之后 12 个月");
    expect(html).not.toContain("盈利假设依赖前瞻估计。");
    data.state!.latestQuote = null; data.state!.current!.input.quote = null;
    const missing = render(data);
    expect(missing).not.toContain("<dt>留档价</dt>"); expect(missing).toContain("未保存有效报价");
    expect(missing).not.toContain("NaN%"); expect(missing).not.toContain("Infinity%");
  });

  it("keeps partial coverage and sample sensitivity explicit without changing targets", () => {
    const data = page(); data.state!.reasons = ["事件来源存在缺项"];
    const html = render(data);
    expect(html).toContain("事件来源存在缺项"); expect(html).toContain("当前有效同业不足 4 家");
    data.state!.current!.peers.push({ symbol: "AVGO", ntmEps: 7, pe: 30 });
    const compared = render(data);
    expect(compared).toContain("逐次剔除一家"); expect(compared).toContain("不调整已发布目标");
    expect(compared).toContain("$120.00");
  });
});

describe("fundamental snapshot API", () => {
  it("reads a normalized symbol and exact entry timestamp without generating a valuation", async () => {
    vi.mocked(getFundamentalPage).mockReset().mockResolvedValue(page());
    const response = await GET(new Request("https://example.com/api/fundamental/amd?entryAt=2026-01-01T09%3A00%3A00%2B08%3A00"), { params: Promise.resolve({ symbol: "amd" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getFundamentalPage).toHaveBeenCalledExactlyOnceWith("AMD", { entryAt: "2026-01-01T01:00:00.000Z" });
    expect((await response.json()).symbol).toBe("AMD");
  });
  it("rejects ambiguous, impossible, future or path-like inputs before snapshot reads", async () => {
    vi.mocked(getFundamentalPage).mockReset();
    for (const entryAt of ["2026-01-01", "2026-01-01T09:00:00", "2026-02-30T09:00:00Z", "2099-01-01T09:00:00Z", ""]) {
      const response = await GET(new Request(`https://example.com/api/fundamental/AMD?entryAt=${encodeURIComponent(entryAt)}`), { params: Promise.resolve({ symbol: "AMD" }) });
      expect(response.status).toBe(400);
    }
    expect((await GET(new Request("https://example.com/api/fundamental/bad"), { params: Promise.resolve({ symbol: "../AMD" }) })).status).toBe(400);
    expect(getFundamentalPage).not.toHaveBeenCalled();
  });
  it("returns a sanitized unavailable error when a snapshot read throws", async () => {
    vi.mocked(getFundamentalPage).mockReset().mockRejectedValue(new Error("private-token=secret"));
    const response = await GET(new Request("https://example.com/api/fundamental/AMD"), { params: Promise.resolve({ symbol: "AMD" }) });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private-token");
  });
});
