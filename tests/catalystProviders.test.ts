import { describe, expect, it, vi } from "vitest";
import { classifyCatalystHeadline, collectCatalystSources, parseBeaCalendar, parseBlsCalendar, parseFedCalendar, parseSecSubmissions } from "@/lib/catalyst/providers";
import type { CatalystUniverse } from "@/lib/catalyst/types";

const now = new Date("2026-09-26T04:00:00Z");
const universe: CatalystUniverse = {
  asOf: "2026-09-25", observedAt: now.toISOString(),
  symbols: [{ symbol: "AMD", name: "Advanced Micro Devices", sectorId: "technology", industry: "Semiconductors", relations: [{ kind: "portfolio", key: "2h:AMD", label: "2H 持仓", tf: "2h", asOf: "2026-09-25", observedAt: now.toISOString() }] }],
  sectors: [], signals: [], health: [],
};
const bls = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:bls-1\r\nDTSTART;TZID=America/New_York:20261002T083000\r\nSUMMARY:Employment Situation\r\nURL:https://www.bls.gov/news.release/empsit.toc.htm\r\nLAST-MODIFIED:20260920T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;
const bea = `<table id="release-schedule-table"><thead><tr><th>Year 2026</th></tr></thead><tbody><tr class="scheduled-releases-type-press"><td class="scheduled-date"><div class="release-date">September 30</div><small>8:30 AM</small></td><td class="release-title views-field">Personal Income and Outlays, August 2026</td><td><a href="/news/2026/personal-income-and-outlays-august-2026">View</a></td></tr></tbody></table>`;
const fed = `<h4><a>2026 FOMC Meetings</a></h4><div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>October</strong></div><div class="fomc-meeting__date col-xs-4">27-28</div></div><div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5">December</div><div class="fomc-meeting__date col-xs-4">8-9*</div></div>`;
const submission = {
  filings: { recent: {
    form: ["8-K", "8-K", "6-K", "10-Q", "8-K"],
    filingDate: ["2026-09-25", "2026-09-24", "2026-09-24", "2026-09-24", "2026-08-01"],
    accessionNumber: ["0000002488-26-000001", "0000002488-26-000002", "0000002488-26-000003", "0000002488-26-000004", "0000002488-26-000005"],
    primaryDocument: ["results.htm", "board.htm", "report.htm", "10q.htm", "old.htm"],
    acceptanceDateTime: ["2026-09-25T20:12:00Z", "2026-09-24T14:00:00Z", "2026-09-24T13:00:00", "2026-09-24T13:00:00Z", "2026-08-01T13:00:00Z"],
    items: ["2.02,9.01", "5.02,9.01", "", "", "2.02"],
  } },
};
function reply(body: unknown, status = 200) { return new Response(typeof body === "string" ? body : JSON.stringify(body), { status }); }
function fixtureFetch(extra?: (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const custom = await extra?.(url, init);
    if (custom) return custom;
    if (url.hostname === "www.bls.gov") return reply(bls);
    if (url.hostname === "www.bea.gov") return reply(bea);
    if (url.hostname === "www.federalreserve.gov") return reply(fed);
    throw new Error(`Unexpected fixture URL: ${url.hostname}`);
  }) as typeof fetch;
}

describe("official catalyst calendar parsers", () => {
  it("keeps the stated New York release time, UID, modification and source URL", () => {
    const parsed = parseBlsCalendar(bls, now);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({ externalId: "bls-1", eventAt: "2026-10-02T12:30:00.000Z", eventDate: "2026-10-02", session: "pre", status: "scheduled", timePrecision: "minute", publishedAt: null, sourceUpdatedAt: "2026-09-20T13:00:00.000Z" });
  });
  it("unfolds ICS lines, decodes escapes, preserves all-day cancellation without inventing a time", () => {
    const input = bls.replace("DTSTART;TZID=America/New_York:20261002T083000", "DTSTART;VALUE=DATE:20261002").replace("SUMMARY:Employment Situation", "SUMMARY:Employment\\,\r\n Situation\r\nSTATUS:CANCELLED");
    expect(parseBlsCalendar(input, now).events[0]).toMatchObject({ title: "Employment,Situation", eventAt: null, timePrecision: "date", status: "cancelled" });
  });
  it("does not interpret floating timestamps as New York or server local time", () => {
    const parsed = parseBlsCalendar(bls.replace("DTSTART;TZID=America/New_York:", "DTSTART:"), now);
    expect(parsed.rejected).toBe(1);
    expect(parsed.events[0]).toMatchObject({ eventAt: null, timing: "unknown", timePrecision: "date" });
  });
  it("applies winter daylight-saving offset and does not infer publication when the calendar time passes", () => {
    const parsed = parseBlsCalendar(bls.replace("20261002T083000", "20261204T083000"), new Date("2026-12-04T18:00:00Z"));
    expect(parsed.events[0]).toMatchObject({ eventAt: "2026-12-04T13:30:00.000Z", status: "scheduled", publishedAt: null });
  });
  it("reads BEA explicit table year, title, time and source link", () => {
    expect(parseBeaCalendar(bea, now).events[0]).toMatchObject({ eventDate: "2026-09-30", eventAt: "2026-09-30T12:30:00.000Z", importance: "high", sourceUrl: "https://www.bea.gov/news/2026/personal-income-and-outlays-august-2026", status: "scheduled" });
  });
  it("keeps missing BEA time as date-only and strips markup", () => {
    const parsed = parseBeaCalendar(bea.replace("<small>8:30 AM</small>", "").replace("Personal Income", "<strong>Personal Income</strong>"), now);
    expect(parsed.events[0]).toMatchObject({ timePrecision: "date", eventAt: null, title: "Personal Income and Outlays, August 2026" });
    expect(parseBeaCalendar(bea.replace(/<a href=[\s\S]*?<\/a>/, ""), now).events[0].sourceUrl).toBe("https://www.bea.gov/news/schedule/full");
  });
  it("does not infer a BEA year from a release's covered quarter", () => {
    expect(() => parseBeaCalendar(bea.replace("Year 2026", "Release"), now)).toThrow("结构无法识别");
  });
  it("retains FOMC end dates with unknown time, including two-month meetings", () => {
    expect(parseFedCalendar(fed, now).events.map(e => [e.eventDate, e.eventAt, e.timing])).toEqual([["2026-10-28", null, "estimated"], ["2026-12-09", null, "estimated"]]);
    const crossMonth = fed.replace("October", "Apr/May").replace("27-28", "30-1");
    expect(parseFedCalendar(crossMonth, new Date("2026-04-28T12:00:00Z")).events[0].eventDate).toBe("2026-05-01");
  });
  it("does not treat an unrecognized or blocked HTML page as an empty healthy calendar", () => {
    for (const parser of [parseBlsCalendar, parseBeaCalendar, parseFedCalendar]) expect(() => parser("<html>Access denied</html>", now)).toThrow();
    expect(() => parseBlsCalendar("BEGIN:VCALENDAR\nEND:VCALENDAR", now)).toThrow();
    expect(() => parseBeaCalendar(bea, new Date("2027-09-26T04:00:00Z"))).toThrow("未覆盖当前年份");
    expect(() => parseFedCalendar(fed, new Date("2027-09-26T04:00:00Z"))).toThrow("未覆盖当前年份");
  });
});

describe("SEC factual filing metadata", () => {
  it("calls only item 2.02 results earnings; other 8-K and 6-K remain corporate disclosures", () => {
    const parsed = parseSecSubmissions(submission, "AMD", "0000002488", universe, now);
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events.map(e => e.type)).toEqual(["Earnings", "Corporate", "Corporate"]);
    expect(parsed.events[0]).toMatchObject({ publishedAt: "2026-09-25T20:12:00.000Z", session: "after", sourceUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000001/results.htm" });
    expect(parsed.events[2]).toMatchObject({ publishedAt: null, eventAt: null, eventDate: "2026-09-24", timePrecision: "date", session: "unknown" });
  });
  it("discards invalid paths, accession numbers, and future acceptance dates", () => {
    const data = structuredClone(submission);
    data.filings.recent.primaryDocument[0] = "../../secret";
    data.filings.recent.accessionNumber[1] = "garbage";
    data.filings.recent.acceptanceDateTime[2] = "2026-09-27T14:00:00Z";
    const parsed = parseSecSubmissions(data, "AMD", "2488", universe, now);
    expect(parsed.events).toHaveLength(0);
    expect(parsed.rejected).toBe(2);
  });
});

describe("bounded independent source collection", () => {
  it("leaves unconfigured sources disabled while official calendars are available", async () => {
    const fetcher = fixtureFetch();
    const results = await collectCatalystSources(universe, now, { fetch: fetcher, env: {}, sleep: async () => {} });
    expect(results.map(r => [r.health.id, r.health.state])).toEqual([
      ["alpaca-news", "disabled"], ["fmp-earnings", "disabled"], ["bls-calendar", "ok"], ["bea-calendar", "ok"], ["fed-calendar", "ok"], ["sec-filings", "disabled"],
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("keeps an upstream failure separate and never puts a credential/error body in health", async () => {
    const fetcher = fixtureFetch(url => {
      if (url.hostname === "www.bls.gov") return reply("Forbidden secret-content", 403);
      if (url.hostname === "financialmodelingprep.com") throw new Error("network apikey=secret-test-key");
    });
    const results = await collectCatalystSources(universe, now, { fetch: fetcher, env: { FMP_API_KEY: "secret-test-key" } });
    expect(results.find(r => r.health.id === "bea-calendar")?.health.state).toBe("ok");
    expect(results.find(r => r.health.id === "bls-calendar")?.health).toMatchObject({ state: "unavailable", count: 0, detail: "来源返回 HTTP 403" });
    expect(results.find(r => r.health.id === "fmp-earnings")?.health.state).toBe("unavailable");
    expect(JSON.stringify(results)).not.toMatch(/secret-content|secret-test-key/);
  });
  it("reads exact news timestamps and limits content to a summary without inferring a future event", async () => {
    const fetcher = fixtureFetch((url, init) => {
      if (url.hostname !== "data.alpaca.markets") return;
      expect(url.searchParams.get("include_content")).toBe("false");
      expect(url.searchParams.get("symbols")).toBe("AMD");
      expect(url.searchParams.get("end")).toBe("2026-09-26T03:45:00.000Z");
      expect(init?.headers).toMatchObject({ "APCA-API-KEY-ID": "news-key", "APCA-API-SECRET-KEY": "news-secret" });
      return reply({ news: [{ id: 123, headline: "AMD Announces New Product", summary: "<p>Launch details.</p>", content: "NEVER STORE FULL ARTICLE", created_at: "2026-09-25T20:30:00Z", updated_at: "2026-09-25T21:00:00Z", url: "https://news.example.net/amd?token=sensitive&utm_source=x", source: "Benzinga", symbols: ["AMD", "NVDA"] }], next_page_token: null });
    });
    const news = (await collectCatalystSources(universe, now, { fetch: fetcher, env: { ALPACA_API_KEY: "news-key", ALPACA_API_SECRET: "news-secret" } }))[0];
    expect(news.health.state).toBe("ok");
    expect(news.events[0]).toMatchObject({ type: "Product", eventAt: "2026-09-25T20:30:00.000Z", eventDate: "2026-09-25", session: "after", sourceUpdatedAt: "2026-09-25T21:00:00.000Z", symbols: ["AMD"], sectorIds: ["technology"], excerpt: "Launch details." });
    expect(JSON.stringify(news)).not.toMatch(/sensitive|NEVER STORE/);
  });
  it("caps pagination at five requests and marks remaining news as partial", async () => {
    let pages = 0;
    const fetcher = fixtureFetch(url => {
      if (url.hostname !== "data.alpaca.markets") return;
      pages++;
      expect(url.searchParams.get("page_token")).toBe(pages === 1 ? null : `page-${pages - 1}`);
      return reply({ news: [], next_page_token: `page-${pages}` });
    });
    const news = (await collectCatalystSources(universe, now, { fetch: fetcher, env: { ALPACA_API_KEY: "key", ALPACA_API_SECRET: "secret" } }))[0];
    expect(pages).toBe(5);
    expect(news.health).toMatchObject({ state: "partial", count: 0 });
    expect(news.health.detail).toContain("尚有新闻未读取");
  });
  it("maps Alpaca class-share and confirmed ticker aliases back to internal universe symbols", async () => {
    const aliases = { ...universe, symbols: ["BRK-B", "PSTG"].map(symbol => ({ ...universe.symbols[0], symbol })) };
    const fetcher = fixtureFetch(url => {
      if (url.hostname !== "data.alpaca.markets") return;
      expect(url.searchParams.get("symbols")).toBe("BRK.B,P");
      return reply({ news: [{ id: 12, headline: "Company update", summary: "Reported update.", created_at: "2026-09-25T16:00:00Z", updated_at: "2026-09-25T16:00:00Z", url: "https://news.example.net/update", symbols: ["BRK.B", "P"] }], next_page_token: null });
    });
    const news = (await collectCatalystSources(aliases, now, { fetch: fetcher, env: { ALPACA_API_KEY: "key", ALPACA_API_SECRET: "secret" } }))[0];
    expect(news.events[0].symbols).toEqual(["BRK-B", "PSTG"]);
  });
  it("does not report news as healthy if rows are malformed or a later page fails", async () => {
    let count = 0;
    const fetcher = fixtureFetch(url => {
      if (url.hostname !== "data.alpaca.markets") return;
      if (++count === 1) return reply({ news: [{ id: 1, headline: "No date" }], next_page_token: "next" });
      return reply("secret body", 429);
    });
    const news = (await collectCatalystSources(universe, now, { fetch: fetcher, env: { ALPACA_API_KEY: "key", ALPACA_API_SECRET: "secret" } }))[0];
    expect(news.health.state).toBe("partial");
    expect(news.health.detail).toBe("来源返回 HTTP 429");
  });
  it("keeps FMP schedules estimated and does not invent precise publication times or use actual EPS", async () => {
    const fetcher = fixtureFetch(url => {
      if (url.hostname !== "financialmodelingprep.com") return;
      expect(url.searchParams.get("from")).toBe("2026-09-26");
      expect(url.searchParams.get("to")).toBe("2026-10-03");
      return reply([{ symbol: "AMD", date: "2026-10-01", time: "amc", epsActual: 99 }, { symbol: "NVDA", date: "2026-10-01" }, { symbol: "AMD", date: "2026-09-01" }]);
    });
    const fmp = (await collectCatalystSources(universe, now, { fetch: fetcher, env: { FMP_API_KEY: "secret-fmp" } }))[1];
    expect(fmp.health.state).toBe("ok"); expect(fmp.events).toHaveLength(1);
    expect(fmp.events[0]).toMatchObject({ eventDate: "2026-10-01", eventAt: null, publishedAt: null, timePrecision: "session", session: "after", status: "scheduled", timing: "estimated" });
    expect(JSON.stringify(fmp)).not.toMatch(/secret-fmp|epsActual/);
  });
  it("does not call SEC with placeholder contact data", async () => {
    const fetcher = fixtureFetch();
    const sec = (await collectCatalystSources(universe, now, { fetch: fetcher, env: { SEC_USER_AGENT: "alpha-agent admin@alpha-agent.local" } }))[5];
    expect(sec.health.state).toBe("disabled"); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("reads SEC only for priority symbols with a real caller identity and reports coverage", async () => {
    const sleep = vi.fn(async () => {});
    const fetcher = fixtureFetch((url, init) => {
      if (!url.hostname.endsWith("sec.gov")) return;
      expect(init?.headers).toMatchObject({ "User-Agent": "Research ops@my-fund.net" });
      if (url.pathname.endsWith("company_tickers.json")) return reply({ "0": { ticker: "AMD", cik_str: 2488 } });
      expect(url.pathname).toBe("/submissions/CIK0000002488.json");
      return reply(submission);
    });
    const sec = (await collectCatalystSources(universe, now, { fetch: fetcher, env: { SEC_USER_AGENT: "Research ops@my-fund.net" }, sleep }))[5];
    expect(sec.health).toMatchObject({ state: "ok", count: 3 }); expect(sleep).toHaveBeenCalledWith(150);
  });
  it("caps SEC coverage at ten companies and exposes partial whole-universe coverage", async () => {
    const many = { ...universe, symbols: Array.from({ length: 12 }, (_, i) => ({ ...universe.symbols[0], symbol: `A${i}` })) };
    let requests = 0;
    const fetcher = fixtureFetch(url => {
      if (!url.hostname.endsWith("sec.gov")) return;
      if (url.pathname.endsWith("company_tickers.json")) return reply(Object.fromEntries(many.symbols.map((s, i) => [i, { ticker: s.symbol, cik_str: i + 1 }])));
      requests++; return reply({ filings: { recent: { form: [], filingDate: [], accessionNumber: [] } } });
    });
    const sec = (await collectCatalystSources(many, now, { fetch: fetcher, env: { SEC_USER_AGENT: "Research ops@my-fund.net" }, sleep: async () => {} }))[5];
    expect(requests).toBe(10); expect(sec.health.state).toBe("partial"); expect(sec.health.detail).toContain("全池 12 只");
  });
  it("uses subject classifications without claiming positive or negative market impact", () => {
    expect(classifyCatalystHeadline("FDA announces trial results")).toEqual({ type: "FDA / Clinical", importance: "high" });
    expect(classifyCatalystHeadline("Unusual volume in AMD shares")).toEqual({ type: "Other", importance: "low" });
  });
});
