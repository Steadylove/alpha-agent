import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCsvPanel, readCsvPanel } from "@/lib/backtest/csvPanel";

// 执行真实刷新脚本；只缩小股票池并替换网络边界，合并、聚合、落盘和发布检查均用生产实现。
vi.mock("@/lib/backtest/smallFundPools", () => ({ tickersForPool: () => ["MMC", "PSTG", "AAPL"] }));
vi.mock("@/lib/scoring/rotationUniverse", () => ({ ROTATION_UNIVERSE: [] }));
vi.mock("@/lib/scoring/sectorUniverse", () => ({ SECTOR_UNIVERSE: [] }));
vi.mock("@/lib/scoring/mpr", () => ({ MPR_SYMBOLS: [] }));
vi.mock("@/lib/data-sources/cboe", () => ({ fetchCboeVolIndexHistory: async () => [] }));

let root: string;
let failSymbol: string | null;
let requests: URL[];
let previousExitCode: typeof process.exitCode;
const priorDates: Record<string, string> = { MMC: "2026-01-13", PSTG: "2026-04-16", AAPL: "2026-09-08" };
const bar = (date: string, close = 100) => ({ date, open: close, high: close + 1, low: close - 1, close, volume: 100 });
const hours = (date: string) => Array.from({ length: 7 }, (_, i) => bar(`${date}T${(date < "2026-03" ? 14 : 13) + i}:30`, 100 + i));
const file = (tf: string, symbol: string) => path.join(root, tf, `${symbol}.csv`);

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(path.join(tmpdir(), "market-refresh-"));
  vi.stubEnv("MARKET_DATA_DIR", root);
  for (const name of ["ALPACA_API_KEY", "ALPACA_API_SECRET", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY"]) vi.stubEnv(name, "");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-10T01:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  previousExitCode = process.exitCode; process.exitCode = 0;
  failSymbol = null; requests = [];
  for (const [symbol, date] of Object.entries(priorDates)) {
    writeCsvPanel(path.join(root, "1d"), symbol, [bar(date)]);
    writeCsvPanel(path.join(root, "1h"), symbol, hours(date));
    writeCsvPanel(path.join(root, "4h"), symbol, hours(date).filter((_, i) => i === 0 || i === 4));
    writeCsvPanel(path.join(root, "2h"), symbol, hours(date).slice(0, 3));
  }
  writeFileSync(path.join(root, "MANIFEST.json"), '{"generatedAt":"previous"}');
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(input); requests.push(url);
    const symbol = url.pathname.split("/").at(-1)!;
    if (["MMC", "PSTG"].includes(symbol) || (symbol === failSymbol && url.searchParams.get("interval") === "1h")) {
      return new Response("not found", { status: 404 });
    }
    const original = symbol === "MRSH" ? "MMC" : symbol === "P" ? "PSTG" : symbol;
    const prior = priorDates[original] ?? "2026-09-08";
    const rows = url.searchParams.get("interval") === "1h"
      ? [...hours(prior).map((b) => ({ ...b, close: 999 })), ...hours("2026-09-09")]
      : [bar(prior, 999), bar("2026-09-09", 110)];
    return Response.json({ chart: { result: [{ timestamp: rows.map((b) => Date.parse(b.date.length === 10 ? `${b.date}T13:30:00Z` : `${b.date}:00Z`) / 1000),
      indicators: { quote: [{ open: rows.map((b) => b.open), high: rows.map((b) => b.high), low: rows.map((b) => b.low), close: rows.map((b) => b.close), volume: rows.map((b) => b.volume) }] },
    }] } });
  }));
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function refresh() {
  vi.resetModules();
  await import("../scripts/refresh-market-csv");
  await vi.waitFor(() => expect(process.exitCode === 1 || !existsSync(path.join(root, ".market-updating"))).toBe(true));
}

describe("改代码股票的完整 CSV 刷新", () => {
  it("旧代码补到最新、历史值保留、标准2H发布完成，重跑不重复追加", async () => {
    const history = new Map(Object.keys(priorDates).flatMap((s) => ["1d", "1h", "4h"].map((tf) => [file(tf, s), readFileSync(file(tf, s), "utf8")] as const)));
    await refresh();
    expect(process.exitCode).toBe(0);
    expect(requests.some((url) => url.pathname.endsWith("/MRSH"))).toBe(true);
    expect(requests.some((url) => url.pathname.endsWith("/P"))).toBe(true);
    for (const [name, original] of history) expect(readFileSync(name, "utf8").startsWith(original)).toBe(true);
    for (const symbol of Object.keys(priorDates)) {
      for (const tf of ["1d", "1h", "2h", "4h"]) {
        const panel = readCsvPanel(path.join(root, tf), symbol)!;
        expect(panel.dates.at(-1)?.slice(0, 10)).toBe("2026-09-09");
        expect(new Set(panel.dates).size).toBe(panel.dates.length);
      }
      const two = readCsvPanel(path.join(root, "2h"), symbol)!;
      expect(two.dates.filter((d) => d.startsWith("2026-09-09"))).toEqual(["2026-09-09T13:30", "2026-09-09T15:30", "2026-09-09T17:30", "2026-09-09T19:30"]);
    }
    expect(readdirSync(path.join(root, "1h")).sort()).toEqual(["AAPL.csv", "MMC.csv", "PSTG.csv"]);
    expect(JSON.parse(readFileSync(path.join(root, "MANIFEST.json"), "utf8")).timeframes["2h"].asOf).toBe("2026-09-09T19:30");
    const first = readFileSync(file("2h", "MMC"), "utf8");
    await refresh();
    expect(process.exitCode).toBe(0);
    expect(readFileSync(file("2h", "MMC"), "utf8")).toBe(first);
  });

  it("新代码也请求失败时仍中止，旧2H和已发布清单保持原样", async () => {
    failSymbol = "P";
    const oldTwo = readFileSync(file("2h", "PSTG"), "utf8");
    const oldManifest = readFileSync(path.join(root, "MANIFEST.json"), "utf8");
    await refresh();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("1H 同步失败，停止发布 2H") }));
    expect(readFileSync(file("2h", "PSTG"), "utf8")).toBe(oldTwo);
    expect(readFileSync(path.join(root, "MANIFEST.json"), "utf8")).toBe(oldManifest);
    expect(existsSync(path.join(root, ".market-updating"))).toBe(true);
  });
});
