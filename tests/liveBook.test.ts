import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MembershipSpan } from "@/lib/backtest/engine";
import {
  appendLiveBookChange,
  applyLiveBookChanges,
  extraLiveTickers,
  inLiveSpan,
  readLiveBook,
} from "@/lib/backtest/liveBook";
import { membersOn, membershipForPool, tickersForPool } from "@/lib/backtest/smallFundPools";
import { SMALL_FUND_UNIVERSE } from "@/lib/backtest/smallFundUniverse";

function spans(...rows: MembershipSpan[]): Map<string, MembershipSpan[]> {
  return new Map(rows.map((s, i) => [`T${i}`, [s]]));
}

describe("liveBook", () => {
  const prev = process.env.LIVE_BOOK_PATH;
  afterEach(() => {
    if (prev == null) delete process.env.LIVE_BOOK_PATH;
    else process.env.LIVE_BOOK_PATH = prev;
  });

  it("纳入从生效日起算，剔除从当天起不算", () => {
    const base = new Map<string, MembershipSpan[]>([
      ["OLD", [{ start: "1900-01-01", end: null }]],
    ]);
    const next = applyLiveBookChanges(base, [
      { id: "1", ticker: "NEW", action: "add", date: "2026-06-01", reason: "跟", at: "2026-06-01T00:00:00Z" },
      { id: "2", ticker: "OLD", action: "remove", date: "2026-07-01", reason: "弱", at: "2026-07-01T00:00:00Z" },
    ]);
    expect(inLiveSpan("2026-05-31", next.get("NEW") ?? [])).toBe(false);
    expect(inLiveSpan("2026-06-01", next.get("NEW") ?? [])).toBe(true);
    expect(inLiveSpan("2026-06-30", next.get("OLD") ?? [])).toBe(true);
    expect(inLiveSpan("2026-07-01", next.get("OLD") ?? [])).toBe(false);
    expect(inLiveSpan("2026-07-01T09:30", next.get("OLD") ?? [])).toBe(false);
  });

  it("写入后 extra 列出新票，membersOn 跟着变", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "live-book-"));
    process.env.LIVE_BOOK_PATH = path.join(dir, "live-book.json");
    expect(readLiveBook()).toEqual([]);
    expect(extraLiveTickers(readLiveBook())).toEqual([]);

    appendLiveBookChange({ ticker: "zzzz", action: "add", date: "2026-08-25", reason: "试新票" });
    expect(extraLiveTickers(readLiveBook())).toEqual(["ZZZZ"]);
    expect(tickersForPool("sf-live", readLiveBook())).toContain("ZZZZ");
    expect(membersOn("sf-live", "2026-08-24", readLiveBook())).not.toContain("ZZZZ");
    expect(membersOn("sf-live", "2026-08-25", readLiveBook())).toContain("ZZZZ");

    appendLiveBookChange({ ticker: "NVDA", action: "remove", date: "2026-08-20", reason: "试剔除" });
    const live = membershipForPool("sf-live", ["NVDA"], readLiveBook());
    expect(inLiveSpan("2026-08-19", live.get("NVDA") ?? [])).toBe(true);
    expect(inLiveSpan("2026-08-20", live.get("NVDA") ?? [])).toBe(false);
    expect(membersOn("sf-live", "2026-08-20", readLiveBook())).not.toContain("NVDA");
    expect(SMALL_FUND_UNIVERSE).toContain("NVDA");
  });
});
