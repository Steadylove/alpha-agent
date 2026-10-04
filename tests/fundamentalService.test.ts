import { describe, expect, it, vi } from "vitest";
import { refreshFundamentalSymbol } from "@/lib/fundamental/service";
import { FundamentalRateLimitError } from "@/lib/fundamental/providers";
import { fundamentalFixture, fundamentalNow as now, fundamentalStateFixture } from "./fixtures/fundamental";

describe("fundamental refresh isolation and stability", () => {
  it("shares an existing ticker state without collecting or paying twice", async () => {
    const previous = fundamentalStateFixture(), collect = vi.fn(), save = vi.fn();
    const result = await refreshFundamentalSymbol("ACME", { now }, { collect, save, read: () => previous });
    expect(result.status).toBe("cached"); expect(collect).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it("retains the same version and skips AI when only price changes", async () => {
    const previous = fundamentalStateFixture(), input = fundamentalFixture();
    input.quote!.price = 180;
    const result = await refreshFundamentalSymbol("ACME", { now, force: true }, {
      read: () => previous, save: vi.fn(), collect: async () => input,
    });
    expect(result.state.status).toBe("ready"); expect(result.state.current!.id).toBe(previous.current!.id);
    expect(result.state.latestQuote!.price).toBe(180);
  });
  it("preserves a successful target as stale after a source outage", async () => {
    const previous = fundamentalStateFixture();
    const result = await refreshFundamentalSymbol("ACME", { now, force: true }, {
      read: () => previous, save: vi.fn(), collect: async () => { throw new Error("private provider detail"); },
    });
    expect(result.state.status).toBe("stale"); expect(result.state.current!.id).toBe(previous.current!.id);
    expect(JSON.stringify(result.state)).not.toContain("private provider detail");
  });
  it.each([true, false])("reports rate limits without changing the prior valuation (has prior: %s)", async (hasPrior) => {
    const previous = hasPrior ? fundamentalStateFixture() : null;
    const analyze = vi.fn(), save = vi.fn();
    const result = await refreshFundamentalSymbol("ACME", { now, force: true }, {
      read: () => previous, save, analyze, collect: async () => { throw new FundamentalRateLimitError(); },
    });
    expect(result.state.status).toBe(hasPrior ? "stale" : "unavailable");
    expect(result.state.current).toEqual(previous?.current ?? null);
    expect(result.state.reasons.join()).toContain("HTTP 429");
    expect(result.state.reasons.join()).toContain("限流");
    expect(result.state.nextCheckAt).toBe(new Date(now.getTime() + 6 * 3600000).toISOString());
    expect(analyze).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(result.state);
  });
  it("publishes verified numbers when optional AI fails", async () => {
    const result = await refreshFundamentalSymbol("ACME", { now }, {
      read: () => null, save: vi.fn(), collect: async () => fundamentalFixture(),
      analyze: async () => { throw new Error("model unavailable"); },
    });
    expect(result.state.status).toBe("ready");
    expect(result.state.current!.twelveMonth.weightedTarget).toBeCloseTo(205.5 * (89 / 365 + 277 / 366));
    expect(result.state.analystStatus).toBe("unavailable");
  });
  it("keeps a material event pending across retries until explicitly reviewed", async () => {
    const pending = (await refreshFundamentalSymbol("ACME", { now, eventIds: ["merger-1"] }, {
      read: () => fundamentalStateFixture(), save: vi.fn(), collect: async () => fundamentalFixture(),
    })).state;
    expect(pending.status).toBe("stale");
    const retry = await refreshFundamentalSymbol("ACME", { now, force: true }, {
      read: () => pending, save: vi.fn(), collect: async () => fundamentalFixture(),
    });
    expect(retry.state.status).toBe("stale"); expect(retry.state.eventIds).toEqual(["merger-1"]);
    const reviewed = await refreshFundamentalSymbol("ACME", { now, reviewedEventIds: ["merger-1"] }, {
      read: () => pending, save: vi.fn(), collect: async () => fundamentalFixture(),
    });
    expect(reviewed.state.status).toBe("ready"); expect(reviewed.state.eventIds).toEqual([]);
  });
  it("retries a missing explanation without moving numerical targets or extending expiry", async () => {
    const previous = fundamentalStateFixture(); previous.analystStatus = "unavailable";
    const generate = vi.fn().mockResolvedValue({ generatedAt: now.toISOString(), model: "test", inputHash: "test", usage: null,
      summary: { text: "summary", sourceIds: ["financials"] }, drivers: [{ text: "driver", sourceIds: ["financials"] }], risks: [{ text: "risk", sourceIds: ["financials"] }] });
    const result = await refreshFundamentalSymbol("ACME", { now, force: true }, {
      read: () => previous, save: vi.fn(), collect: async () => fundamentalFixture(), analyze: generate,
    });
    expect(generate).toHaveBeenCalledOnce(); expect(result.state.analystStatus).toBe("ready");
    expect(result.state.current!.id).not.toBe(previous.current!.id);
    expect(result.state.current!.twelveMonth).toEqual(previous.current!.twelveMonth);
    expect(result.state.current!.validUntil).toBe(previous.current!.validUntil);
    expect(result.state.current!.revision!.changePct).toBe(0);
  });
  it("marks missing forward data unavailable, never zero-valued", async () => {
    const input = fundamentalFixture(); input.estimates = [];
    input.warnings = ["ACME: 年度盈利预测不可用（HTTP 402）。"];
    const result = await refreshFundamentalSymbol("ACME", { now }, { read: () => null, save: vi.fn(), collect: async () => input });
    expect(result.state.status).toBe("unavailable"); expect(result.state.current).toBeNull();
    expect(result.state.reasons).toContain(input.warnings[0]);
  });
});
