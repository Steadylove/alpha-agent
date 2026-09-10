import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readBookEpoch, resetBookEpoch } from "@/lib/fund/bookEpoch";
import { bookEpochOf, normalizeBookFrom } from "@/lib/fund/bookEpochLogic";
import { GET, POST } from "@/app/api/signal-book/route";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "epoch-"));
  file = path.join(dir, "book-epoch.json");
  vi.stubEnv("BOOK_EPOCH_PATH", file);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe("book epoch", () => {
  it("只接受日历日", () => {
    expect(normalizeBookFrom("2026-09-04")).toBe("2026-09-04");
    expect(normalizeBookFrom("2026-09-04T17:30")).toBe("2026-09-04");
    expect(normalizeBookFrom("9/4")).toBeNull();
    expect(normalizeBookFrom("2026-02-30")).toBeNull();
    expect(normalizeBookFrom("2026-13-01")).toBeNull();
  });

  it("缺文件回落到五年窗起点", () => {
    expect(bookEpochOf(null, "2021-08-24")).toEqual({ from: "2021-08-24", resetAt: "" });
  });

  it("旧配置无损承接，2H 和 4H 先后改起点互不覆盖", async () => {
    const old = { from: "2026-01-01", resetAt: "2026-01-02T10:00:00Z" };
    const raw = JSON.stringify(old);
    writeFileSync(file, raw);
    expect((await readBookEpoch()).epochs).toEqual({ "2h": old, "4h": old });
    expect(readFileSync(file, "utf8")).toBe(raw);
    const two = await resetBookEpoch("2h", "2026-09-04", new Date("2026-09-06T10:00:00Z"));
    expect((await readBookEpoch()).epochs).toEqual({ "2h": two, "4h": old });
    const four = await resetBookEpoch("4h", "2026-08-01", new Date("2026-09-06T10:01:00Z"));
    expect((await readBookEpoch()).epochs).toEqual({ "2h": two, "4h": four });
  });

  it("同一日期再次记账也产生新的重置标记", async () => {
    const now = new Date("2026-09-06T10:00:00Z");
    const first = await resetBookEpoch("2h", "2026-01-01", now);
    const second = await resetBookEpoch("2h", "2026-01-01", now);
    expect(second.from).toBe(first.from);
    expect(second.resetAt > first.resetAt).toBe(true);
    expect((await readBookEpoch()).epochs["4h"].resetAt).toBe("");
  });

  it("网页 API 必须明确周期和有效日期，错误请求不会重置任意账本", async () => {
    writeFileSync(file, JSON.stringify({ from: "2026-01-01", resetAt: "" }));
    const before = readFileSync(file, "utf8");
    for (const body of [{ from: "2026-01-01" }, { tf: "1h", from: "2026-01-01" },
      { tf: "2h" }, { tf: "2h", from: "2026-02-30" }, { tf: "2h", from: "9999-01-01" }, null]) {
      const response = await POST(new Request("http://test/api/signal-book", { method: "POST", body: JSON.stringify(body) }));
      expect(response.status).toBe(400);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    const saved = await POST(new Request("http://test/api/signal-book", { method: "POST", body: JSON.stringify({ tf: "2h", from: "2025-01-01" }) }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ tf: "2h", from: "2025-01-01" });
    const two = await GET(new Request("http://test/api/signal-book?tf=2h"));
    const four = await GET(new Request("http://test/api/signal-book?tf=4h"));
    expect(await two.json()).toMatchObject({ tf: "2h", from: "2025-01-01" });
    expect(await four.json()).toMatchObject({ tf: "4h", from: "2026-01-01" });
  });

  it("远程写入带版本条件，冲突不能冒充成功", async () => {
    vi.stubEnv("BOOK_EPOCH_PATH", "");
    vi.stubEnv("MARKET_DATA_BASE_URL", "http://epoch.test");
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PUT"
      ? new Response("记账起点已更新", { status: 409 }) : Response.json({ from: "2026-01-01", resetAt: "", updatedAt: "v1" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(resetBookEpoch("2h", "2026-09-04", new Date("2026-09-06T10:00:00Z"))).rejects.toThrow("已更新");
    const put = fetcher.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(new Headers(put[1]?.headers).get("if-match")).toBe('"v1"');
    expect(JSON.parse(put[1]?.body as string).epochs["4h"].from).toBe("2026-01-01");
  });
});
