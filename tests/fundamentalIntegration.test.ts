import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFundamentalAnalysis, verifyFundamentalAnalysis } from "@/lib/fundamental/analyst";
import { refreshFundamentalSymbol } from "@/lib/fundamental/service";
import { getFundamentalPage, readFundamentalState, saveFundamentalState } from "@/lib/fundamental/store";
import type { FundamentalState, FundamentalValuation } from "@/lib/fundamental/types";
import { fundamentalFixture, fundamentalNow } from "./fixtures/fundamental";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe("fundamental collection-to-page integration", () => {
  it("supplements a failed AI explanation on the next check without rewriting numerical history or entry knowledge", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fundamental-integration-"));
    directories.push(directory);
    let now = new Date(fundamentalNow);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("Temporary model outage"))
      .mockResolvedValueOnce(Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          summary: { text: "估值依赖盈利预期和同行比较，情景区间不代表未来价格保证。", sourceIds: ["estimates", "PEERA", "PEERB", "PEERC"] },
          drivers: [{ text: "同一行业的前瞻盈利倍数提供情景估值参考。", sourceIds: ["PEERA", "PEERB", "PEERC"] }],
          risks: [{ text: "已披露利润与调整后盈利预期口径不同，不能直接推断增长。", sourceIds: ["financials", "estimates"] }],
        }) } }],
        usage: { prompt_tokens: 1_000, completion_tokens: 180 },
      }));
    const collect = vi.fn(async () => fundamentalFixture(now));
    const dependencies = {
      collect,
      read: (symbol: string) => readFundamentalState(symbol, directory),
      save: (state: FundamentalState) => saveFundamentalState(state, directory),
      analyze: (valuation: FundamentalValuation) => generateFundamentalAnalysis(valuation, {
        apiKey: "integration-test-key", fetchImpl, now,
      }),
    };

    const initial = await refreshFundamentalSymbol("ACME", { now }, dependencies);
    const initialValuation = initial.state.current!;
    expect(initial.state.status).toBe("ready");
    expect(initial.state.analystStatus).toBe("unavailable");
    expect(initialValuation.analyst).toBeNull();
    const historyPath = path.join(directory, "ACME", "history");
    const originalBytes = readFileSync(path.join(historyPath, `${initialValuation.id}.json`), "utf8");
    expect(verifyFundamentalAnalysis(initialValuation)).toBeNull();

    now = new Date(fundamentalNow.getTime() + 3_600_000);
    const cached = await refreshFundamentalSymbol("ACME", { now }, dependencies);
    expect(cached.status).toBe("cached");
    expect(collect).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = new Date(fundamentalNow.getTime() + 24 * 3_600_000);
    const retry = await refreshFundamentalSymbol("ACME", { now }, dependencies);
    const enriched = retry.state.current!;
    expect(retry.status).toBe("updated");
    expect(retry.state.status).toBe("ready");
    expect(retry.state.analystStatus).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(enriched.id).not.toBe(initialValuation.id);
    expect(enriched.publishedAt).toBe(now.toISOString());
    expect(enriched.anchorDate).toBe(initialValuation.anchorDate);
    expect(enriched.sixMonth).toEqual(initialValuation.sixMonth);
    expect(enriched.twelveMonth).toEqual(initialValuation.twelveMonth);
    expect(enriched.peers).toEqual(initialValuation.peers);
    expect(enriched.input).toEqual(initialValuation.input);
    expect(enriched.validUntil).toBe(initialValuation.validUntil);
    expect(enriched.revision).toMatchObject({ previousId: initialValuation.id,
      changePct: 0, earningsContribution: 0, multipleContribution: 0 });
    expect(verifyFundamentalAnalysis(enriched)).toEqual(enriched.analyst);
    expect(readFundamentalState("ACME", directory)?.current).toEqual(enriched);
    expect(readdirSync(historyPath)).toHaveLength(2);
    expect(readFileSync(path.join(historyPath, `${initialValuation.id}.json`), "utf8")).toBe(originalBytes);

    // The page reads actual saved JSON; no additional collection or model invocation is allowed.
    const beforeSupplement = await getFundamentalPage("ACME", {
      directory, now, entryAt: new Date(now.getTime() - 1).toISOString(),
    });
    expect(beforeSupplement.error).toBeNull();
    expect(beforeSupplement.state!.current!.analyst).not.toBeNull();
    expect(beforeSupplement.history).toHaveLength(2);
    expect(beforeSupplement.atEntry?.id).toBe(initialValuation.id);
    expect(beforeSupplement.atEntry?.analyst).toBeNull();

    const atPublication = await getFundamentalPage("ACME", { directory, now, entryAt: now.toISOString() });
    expect(atPublication.error).toBeNull();
    expect(atPublication.atEntry?.id).toBe(enriched.id);
    expect(verifyFundamentalAnalysis(atPublication.atEntry!)).toEqual(enriched.analyst);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledTimes(2);
  });
});
