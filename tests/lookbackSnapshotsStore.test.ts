import { afterEach, describe, expect, it, vi } from "vitest";

import { lookbackSnapshotsRemoteUrl, readLookbackSnapshots, saveLookbackSnapshot } from "@/lib/fund/lookbackSnapshots";

describe("lookback snapshot store", () => {
  const prev = {
    MARKET_DATA_BASE_URL: process.env.MARKET_DATA_BASE_URL,
    LOOKBACK_SNAPSHOTS_PATH: process.env.LOOKBACK_SNAPSHOTS_PATH,
    VERCEL: process.env.VERCEL,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prev.MARKET_DATA_BASE_URL === undefined) delete process.env.MARKET_DATA_BASE_URL;
    else process.env.MARKET_DATA_BASE_URL = prev.MARKET_DATA_BASE_URL;
    if (prev.LOOKBACK_SNAPSHOTS_PATH === undefined) delete process.env.LOOKBACK_SNAPSHOTS_PATH;
    else process.env.LOOKBACK_SNAPSHOTS_PATH = prev.LOOKBACK_SNAPSHOTS_PATH;
    if (prev.VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prev.VERCEL;
  });

  it("Vercel 未设路径时走行情机 desk", () => {
    delete process.env.LOOKBACK_SNAPSHOTS_PATH;
    delete process.env.MARKET_DATA_BASE_URL;
    process.env.VERCEL = "1";
    expect(lookbackSnapshotsRemoteUrl()).toBe("http://108.174.50.53:8787/desk/lookback-snapshots.json");
  });

  it("指定本地路径就不走远程", () => {
    process.env.VERCEL = "1";
    process.env.LOOKBACK_SNAPSHOTS_PATH = "/tmp/snaps.json";
    expect(lookbackSnapshotsRemoteUrl()).toBeNull();
  });

  it("远程读空列表，保存发 PUT", async () => {
    delete process.env.LOOKBACK_SNAPSHOTS_PATH;
    process.env.MARKET_DATA_BASE_URL = "http://vps.test";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response('{"ok":true}', { status: 200 });
      return new Response("[]\n", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await readLookbackSnapshots()).toEqual([]);
    await saveLookbackSnapshot({
      members: ["AAPL"],
      tf: "4h",
      from: "2026-01-01",
      slots: 10,
      pnl: "+1%",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    expect(String(put?.[0])).toBe("http://vps.test/desk/lookback-snapshots.json");
    expect(String(put?.[1]?.body)).toContain("AAPL");
  });

  it("VPS 还没 desk 时把 404 说清楚", async () => {
    delete process.env.LOOKBACK_SNAPSHOTS_PATH;
    process.env.MARKET_DATA_BASE_URL = "http://vps.test";
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    await expect(readLookbackSnapshots()).rejects.toThrow(/desk 存储/);
  });
});
