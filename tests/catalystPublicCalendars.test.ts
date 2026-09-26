import { describe, expect, it, vi } from "vitest";
import { collectNasdaqEarnings, collectNewYorkFedBlsCalendar, parseNasdaqEarningsCalendar, parseNewYorkFedBlsCalendar } from "@/lib/catalyst/publicCalendars";
import { collectCatalystSources, parseBeaCalendar } from "@/lib/catalyst/providers";
import type { CatalystUniverse } from "@/lib/catalyst/types";

const now = new Date("2026-09-26T04:00:00Z");
const universe: CatalystUniverse = {
  asOf: "2026-09-25", observedAt: now.toISOString(), sectors: [], signals: [], health: [],
  symbols: ["CCL", "AMD", "MMC", "BRK-B"].map(symbol => ({ symbol, name: symbol, sectorId: "TECH", industry: null, relations: [] })),
};
const reply = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", year: "numeric", month: "short", day: "numeric" }).format(new Date(`${date}T00:00:00Z`));
const nasdaq = (date: string, rows: unknown = null) => ({ data: { asOf: dateLabel(date), headers: rows ? { symbol: "Symbol" } : null, rows }, status: { rCode: 200 } });
const urlOf = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : String(input));
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const calendar = (month = "2026-10", day = "02", clock = "08:30", title = "Employment Situation") => `
<p>Provides key economic data releases (all Eastern Time).</p>
<table><tr><td class="ts-data-table-head"><div>${monthNames[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}</div></td></tr></table>
<table class="research-table-1col greyborder"><tr><td>Monday</td></tr><tr><td><div>${day}<br/><br/><span class="ts-accordion-content"><a href="https://www.bls.gov/news.release/empsit.toc.htm">${title}</a><br/>${clock ? `(${clock})` : ""}<br/><br/><a href="https://www.newyorkfed.org/nowcast">Nowcast</a><br/>(12:45)</span></div></td></tr></table>
<p>Dates and times are tentative and subject to immediate change.</p>`;
const fromPath = (url: URL): string => {
  const match = url.pathname.match(/i-([a-z]{3})(\d{2})\.html/)!;
  return `20${match[2]}-${String(monthNames.findIndex(month => month.toLowerCase().startsWith(match[1])) + 1).padStart(2, "0")}`;
};

describe("Nasdaq public estimated earnings", () => {
  it("takes the response's actual calendar day and session without mistaking last year's report or fiscal quarter for release time", () => {
    const parsed = parseNasdaqEarningsCalendar(nasdaq("2026-09-29", [
      { symbol: "CCL", time: "time-pre-market", lastYearRptDt: "9/29/2025", fiscalQuarterEnding: "Aug/2026", epsForecast: "$1.36" },
      { symbol: "AMD", time: "time-after-hours" }, { symbol: "NOTINPOOL", time: "time-pre-market" },
    ]), "2026-09-29", universe);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toMatchObject({ provider: "nasdaq-earnings", symbols: ["CCL"], sectorIds: ["TECH"], eventDate: "2026-09-29", eventAt: null, publishedAt: null, sourceUpdatedAt: null, session: "pre", timePrecision: "session", timing: "estimated", status: "scheduled", sourceUrl: "https://api.nasdaq.com/api/calendar/earnings?date=2026-09-29" });
    expect(parsed.events[1].session).toBe("after");
    expect(parsed.events[0].excerpt).toContain("并非公司确认公告");
    expect(JSON.stringify(parsed.events)).not.toMatch(/2025|1\.36/);
  });
  it("preserves unknown times as date-only and maps class shares and renamed symbols back to the observed pool", () => {
    const parsed = parseNasdaqEarningsCalendar(nasdaq("2026-09-29", [{ symbol: "BRK.B", time: "time-not-supplied" }, { symbol: "MRSH", time: "new-unknown-value" }]), "2026-09-29", universe);
    expect(parsed.events.map(event => event.symbols[0])).toEqual(["BRK-B", "MMC"]);
    expect(parsed.events.every(event => event.timePrecision === "date" && event.session === "unknown" && event.eventAt === null)).toBe(true);
  });
  it("accepts explicit successful empty days but rejects missing lists, mismatched dates and provider error payloads", () => {
    expect(parseNasdaqEarningsCalendar(nasdaq("2026-09-26"), "2026-09-26", universe).events).toEqual([]);
    expect(() => parseNasdaqEarningsCalendar(nasdaq("2026-09-29"), "2026-09-26", universe)).toThrow();
    expect(() => parseNasdaqEarningsCalendar({ data: { asOf: dateLabel("2026-09-26") }, status: { rCode: 200 } }, "2026-09-26", universe)).toThrow();
    expect(() => parseNasdaqEarningsCalendar({ ...nasdaq("2026-09-26"), status: { rCode: 500 } }, "2026-09-26", universe)).toThrow();
    expect(() => parseNasdaqEarningsCalendar({ data: { asOf: "Tue, Feb 30, 2026", rows: null }, status: { rCode: 200 } }, "2026-02-30", universe)).toThrow();
  });
  it("deduplicates a day's symbol and counts malformed rows without adding guessed events", () => {
    const parsed = parseNasdaqEarningsCalendar(nasdaq("2026-09-29", [{ symbol: "CCL" }, { symbol: "CCL" }, { symbol: "../../bad" }, null]), "2026-09-29", universe);
    expect(parsed.events).toHaveLength(1); expect(parsed.rejected).toBe(2);
  });
  it("reads exactly today through +7 in New York, including empty weekend days, without credentials and with bounded concurrency", async () => {
    let active = 0, maximum = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      active++; maximum = Math.max(maximum, active);
      const url = urlOf(input);
      expect(url.hostname).toBe("api.nasdaq.com"); expect(url.searchParams.has("apikey")).toBe(false);
      expect(init).toMatchObject({ redirect: "error", cache: "no-store" }); expect(init?.signal).toBeInstanceOf(AbortSignal);
      await Promise.resolve(); active--;
      return reply(nasdaq(url.searchParams.get("date")!, [{ symbol: "CCL" }]));
    }) as typeof fetch;
    const result = await collectNasdaqEarnings(universe, new Date("2026-09-26T02:00:00Z"), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(8); expect(maximum).toBeLessThanOrEqual(2);
    expect(result.health).toMatchObject({ state: "ok", count: 8 });
    expect(result.events.at(0)?.eventDate).toBe("2026-09-25"); expect(result.events.at(-1)?.eventDate).toBe("2026-10-02");
  });
  it("retains successful days and reports partial when one date fails, with no raw error contents", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const date = urlOf(input).searchParams.get("date")!;
      if (date === "2026-09-28") throw new Error("token=PRIVATE_SECRET server response body");
      return reply(nasdaq(date, date === "2026-09-29" ? [{ symbol: "CCL" }] : null));
    }) as typeof fetch;
    const result = await collectNasdaqEarnings(universe, now, fetcher);
    expect(result.health).toMatchObject({ state: "partial", count: 1 }); expect(result.health.detail).toContain("7/8");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET");
  });
  it("stops after access denial or rate limiting instead of retrying remaining days", async () => {
    const fetcher = vi.fn(async () => reply("RAW_SECRET", 429)) as typeof fetch;
    const result = await collectNasdaqEarnings(universe, now, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(result.health.state).toBe("unavailable");
    expect(result.health.detail).toContain("HTTP 429"); expect(JSON.stringify(result)).not.toContain("RAW_SECRET");
  });
  it("does not query a public provider when the observed pool is empty", async () => {
    const fetcher = vi.fn() as typeof fetch;
    expect((await collectNasdaqEarnings({ ...universe, symbols: [] }, now, fetcher)).health.state).toBe("disabled"); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("New York Fed's BLS calendar fallback", () => {
  it("attributes the calendar to the New York Fed, uses its explicit ET time and never interprets a calendar event as published", () => {
    const parsed = parseNewYorkFedBlsCalendar(calendar(), "2026-10", now);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({ provider: "bls-calendar", eventDate: "2026-10-02", eventAt: "2026-10-02T12:30:00.000Z", publishedAt: null, sourceUrl: "https://www.newyorkfed.org/research/calendars/i-oct26.html", timing: "estimated", timePrecision: "minute", session: "pre", status: "scheduled" });
    expect(parsed.events[0].sourceName).toContain("Federal Reserve Bank of New York");
    expect(parsed.events[0].excerpt).toContain("部分指标");
  });
  it("converts winter ET with DST and preserves missing clocks without borrowing the next event's time", () => {
    const winter = parseNewYorkFedBlsCalendar(calendar("2026-11", "06"), "2026-11", now);
    expect(winter.events[0].eventAt).toBe("2026-11-06T13:30:00.000Z");
    const missing = parseNewYorkFedBlsCalendar(calendar("2026-10", "02", ""), "2026-10", now);
    expect(missing.events[0]).toMatchObject({ eventAt: null, session: "unknown", timePrecision: "date" });
  });
  it("refuses wrong months, missing timezone, blocked pages and fake BLS link hostnames", () => {
    expect(() => parseNewYorkFedBlsCalendar(calendar(), "2026-11", now)).toThrow();
    expect(() => parseNewYorkFedBlsCalendar(calendar().replace("all Eastern Time", "local time"), "2026-10", now)).toThrow();
    expect(() => parseNewYorkFedBlsCalendar("<html>Access Denied</html>", "2026-10", now)).toThrow();
    expect(() => parseNewYorkFedBlsCalendar(calendar().replace("www.bls.gov/", "www.bls.gov.evil.test/"), "2026-10", now)).toThrow();
  });
  it("rejects impossible days and hours and limits events to the stated window", () => {
    expect(parseNewYorkFedBlsCalendar(calendar("2026-11", "31"), "2026-11", now)).toMatchObject({ rejected: 1, events: [] });
    const malformedTime = parseNewYorkFedBlsCalendar(calendar("2026-10", "02", "25:00"), "2026-10", now);
    expect(malformedTime.rejected).toBe(1); expect(malformedTime.events[0].eventAt).toBeNull();
    expect(parseNewYorkFedBlsCalendar(calendar("2026-09", "02"), "2026-09", now).events).toEqual([]);
    expect(parseNewYorkFedBlsCalendar(calendar("2026-12", "31"), "2026-12", now).events).toEqual([]);
  });
  it("keeps partial coverage even when all months succeed and preserves the primary HTTP failure", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => reply(calendar(fromPath(urlOf(input))))) as typeof fetch;
    const result = await collectNewYorkFedBlsCalendar(now, fetcher, "来源返回 HTTP 403");
    expect(fetcher).toHaveBeenCalledTimes(4); expect(result.health).toMatchObject({ id: "bls-calendar", state: "partial", count: 3 });
    expect(result.health.detail).toContain("BLS 直连 HTTP 403"); expect(result.health.detail).toContain("4/4 个月");
    expect(result.health.detail).toContain("非 BLS 全集");
  });
  it("fetches at most five months over a year boundary and records unavailable months without dropping successful ones", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const month = fromPath(urlOf(input));
      return month === "2027-01" ? reply("private-response", 500) : reply(calendar(month));
    }) as typeof fetch;
    const result = await collectNewYorkFedBlsCalendar(new Date("2026-12-01T16:00:00Z"), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(5); expect(result.health.state).toBe("partial");
    expect(result.health.detail).toContain("1 个月请求或格式无效"); expect(JSON.stringify(result)).not.toContain("private-response");
  });
  it("does not call a blocked fallback repeatedly and never reports an unavailable response as a healthy empty calendar", async () => {
    const fetcher = vi.fn(async () => reply("Access denied with raw details", 403)) as typeof fetch;
    const result = await collectNewYorkFedBlsCalendar(now, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(result.health).toMatchObject({ state: "unavailable", count: 0 });
    expect(JSON.stringify(result)).not.toContain("raw details");
  });
});

describe("BEA official dates not yet announced", () => {
  const bea = `<table><thead><tr><th>Year 2026</th></tr></thead><tbody><tr><td class="scheduled-date"><div class="release-date">September 30</div><small>8:30 AM</small></td><td class="release-title">Personal Income and Outlays</td></tr><tr><td class="scheduled-date"><small>To Be Announced<br />2026</small></td><td class="release-title">Outdoor Recreation Economic Statistics, U.S. and States, 2025</td></tr></tbody></table>`;
  it("distinguishes a true official TBD from malformed fields and does not invent a placeholder date", () => {
    expect(parseBeaCalendar(bea, now)).toMatchObject({ pendingDates: 1, rejected: 0, recognized: 2 });
    expect(parseBeaCalendar(bea, now).events).toHaveLength(1);
    expect(parseBeaCalendar(bea.replace("To Be Announced", "Broken date"), now)).toMatchObject({ rejected: 1 });
  });
  it("reports the published-date coverage and pending item separately", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => urlOf(input).hostname === "www.bea.gov" ? reply(bea) : reply("Unavailable", 403)) as typeof fetch;
    const results = await collectCatalystSources({ ...universe, symbols: [] }, now, { fetch: fetcher, env: {} });
    const result = results.find(source => source.health.id === "bea-calendar")!;
    expect(result.health).toMatchObject({ state: "partial", count: 1 });
    expect(result.health.detail).toContain("已公布日期覆盖 1 条"); expect(result.health.detail).toContain("另有 1 项官方日期待定");
    expect(result.health.detail).not.toContain("时间或字段不完整");
  });
  it("uses the public fallback only after BLS fails, without changing successful primary source identity", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.hostname === "www.newyorkfed.org") return reply(calendar(fromPath(url)));
      return reply("Unavailable", 403);
    }) as typeof fetch;
    const results = await collectCatalystSources({ ...universe, symbols: [] }, now, { fetch: fetcher, env: {} });
    const result = results.find(source => source.health.id === "bls-calendar")!;
    expect(result.health).toMatchObject({ state: "partial", count: 3 });
    expect(result.events.every(event => event.sourceName.includes("New York"))).toBe(true);
  });
});
