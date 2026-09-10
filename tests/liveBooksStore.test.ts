import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookVersionId, listLiveBookVersions, readLiveBooks, readLiveBookVersion, writeLiveBooks } from "@/lib/fund/liveBooksStore";
import { bookCache, continuousCache } from "./liveBooksFixtures";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "books-store-"));
  file = path.join(dir, "live-books.json");
  vi.stubEnv("LIVE_BOOKS_PATH", file);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

function remote() { vi.stubEnv("LIVE_BOOKS_PATH", ""); vi.stubEnv("MARKET_DATA_BASE_URL", "http://books.test"); }

describe("账本持久化", () => {
  it("连续账本的现金、股数、风控和池版本经归档读回不会丢失", async () => {
    const current = continuousCache();
    await writeLiveBooks(current);
    expect(await readLiveBooks()).toEqual(current);
    expect(await readLiveBookVersion(current.runId!)).toEqual(current);
    const corrupt = JSON.parse(readFileSync(file, "utf8"));
    corrupt.books[0].checkpoint.cash = null;
    writeFileSync(file, JSON.stringify(corrupt));
    await expect(readLiveBooks()).rejects.toThrow("恢复状态无效");
    expect(await readLiveBookVersion(current.runId!)).toEqual(current);
  });

  it("读入残缺曲线能立即恢复，下一次保存留完整曲线且不改写历史归档", async () => {
    const damaged = continuousCache();
    damaged.books[0].checkpoint!.dailyEquity.unshift({ date: "2026-01-02", v: 1.01 });
    const source = JSON.stringify(damaged);
    writeFileSync(file, source);
    const restored = (await readLiveBooks())!;
    expect(restored.books[0].sparkline).toEqual([1.01, 1.2]);
    expect(readFileSync(file, "utf8")).toBe(source);
    await writeLiveBooks({ ...damaged, runId: "repaired-run" });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.books[0].view.curve).toHaveLength(2);
    expect(saved.books[0].sparkline).toEqual([1.01, 1.2]);
    const archive = path.join(dir, "book-versions", `${damaged.runId}.json`);
    const archived = readFileSync(archive, "utf8");
    await writeLiveBooks({ ...damaged, runId: "next-run" });
    expect(readFileSync(archive, "utf8")).toBe(archived);
    expect((await readLiveBookVersion(damaged.runId!))!.books[0].checkpoint).toEqual(damaged.books[0].checkpoint);
  });

  it("同一进程在文件更新后读到新结果，旧版本完整保留", async () => {
    const first = bookCache();
    await writeLiveBooks(first);
    expect((await readLiveBooks())?.runId).toBe(first.runId);
    const second = bookCache({ runId: "test-run-2", computedAt: "2026-09-10T00:00:00.000Z", poolKey: "NVDA" });
    await writeLiveBooks(second);
    expect((await readLiveBooks())?.runId).toBe(second.runId);
    expect(await readLiveBookVersion(first.runId!)).toEqual(first);
    expect((await listLiveBookVersions()).map((v) => v.id)).toEqual(["test-run-2", "test-run-1"]);
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("VPS 在两次读取间更新，第二次不会复用内存结果", async () => {
    remote();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(bookCache())).mockResolvedValueOnce(Response.json(bookCache({ runId: "test-run-2" })));
    vi.stubGlobal("fetch", fetcher);
    expect((await readLiveBooks())?.runId).toBe("test-run-1");
    expect((await readLiveBooks())?.runId).toBe("test-run-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("远程写入失败必须抛错，随后读取仍是旧结果", async () => {
    remote();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PUT" ? new Response("disk full", { status: 500 }) : Response.json(bookCache())));
    await expect(writeLiveBooks(bookCache({ runId: "failed-run" }))).rejects.toThrow("disk full");
    expect((await readLiveBooks())?.runId).toBe("test-run-1");
  });

  it("远程不可达不伪装成本地缓存", async () => {
    remote();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(readLiveBooks()).rejects.toThrow("offline");
  });

  it("归档失败不替换当前账本", async () => {
    writeFileSync(file, JSON.stringify(bookCache()));
    writeFileSync(path.join(dir, "book-versions"), "blocks directory");
    await expect(writeLiveBooks(bookCache({ runId: "test-run-2" }))).rejects.toThrow();
    expect(JSON.parse(readFileSync(file, "utf8")).runId).toBe("test-run-1");
  });

  it("升级后第一次重算保留无版本号的旧账本", async () => {
    const legacy = bookCache({ runId: undefined, marketRevision: undefined, strategyKey: undefined });
    writeFileSync(file, JSON.stringify(legacy));
    await writeLiveBooks(bookCache());
    expect(await readLiveBookVersion(bookVersionId(legacy))).toEqual(legacy);
  });

  it("同一个版本不能被不同结果覆盖", async () => {
    await writeLiveBooks(bookCache());
    await expect(writeLiveBooks(bookCache({ poolKey: "MSFT" }))).rejects.toThrow("不能覆盖");
    expect((await readLiveBooks())?.poolKey).toBe("AAPL,NVDA");
  });

  it("损坏结果报错，路径不能越界", async () => {
    writeFileSync(file, "broken json");
    await expect(readLiveBooks()).rejects.toThrow();
    await expect(readLiveBookVersion("../secrets")).rejects.toThrow("版本号无效");
  });
});
