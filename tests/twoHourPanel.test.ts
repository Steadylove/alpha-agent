import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCsvText, readCsvPanel, writeCsvPanel } from "@/lib/backtest/csvPanel";
import { twoHourAsOf, twoHourPanelFromHourly } from "@/lib/backtest/twoHourPanel";
import { rebuildTwoHourCsv } from "@/lib/backtest/rebuildTwoHour";
import { fetchRemoteCsvPanel, loadMarketPanel } from "@/lib/backtest/marketRemote";

const fullDay = Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-08T${13 + i}:30`, open: i + 10,
  high: i + 11, low: i + 9, close: i + 10.5, volume: 100 }));
const csv = (rows = fullDay) => "date,open,high,low,close,volume\n" + rows.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume].join(",")).join("\n");
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "two-hour-")); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("标准 2H 数据源", () => {
  it("由完整 1H 生成四根，并保留末半小时 OHLCV", () => {
    const next = twoHourPanelFromHourly(parseCsvText("CF", csv())!);
    expect(next.dates).toEqual(["2026-09-08T13:30", "2026-09-08T15:30", "2026-09-08T17:30", "2026-09-08T19:30"]);
    expect(Array.from(next.close)).toEqual([11.5, 13.5, 15.5, 16.5]);
    expect(Array.from(next.volume!)).toEqual([200, 200, 200, 100]);
    expect(twoHourAsOf("2026-11-27T17:30")).toBe("2026-11-27T16:30");
  });

  it("拒绝整点分桶及重复时间轴，不能把坏 1H 冒充新 2H", () => {
    expect(() => twoHourPanelFromHourly(parseCsvText("CF", csv().replaceAll(":30", ":00"))!)).toThrow("时间轴无效");
    expect(() => twoHourPanelFromHourly(parseCsvText("CF", csv([...fullDay, fullDay[0]]))!)).toThrow("时间轴无效");
  });

  it("远程和本地单票 2H 入口都只读 1H，缺失时不回落到旧 2H", async () => {
    vi.stubEnv("MARKET_DATA_BASE_URL", "http://market.test");
    const fetcher = vi.fn().mockResolvedValue(new Response(csv()));
    vi.stubGlobal("fetch", fetcher);
    expect((await loadMarketPanel("2h", "CF"))?.dates).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledWith("http://market.test/1h/CF.csv", expect.anything());
    fetcher.mockResolvedValue(new Response("", { status: 404 }));
    expect(await fetchRemoteCsvPanel("2h", "CF")).toBeNull();
    expect(fetcher.mock.calls.every(([url]) => String(url).includes("/1h/"))).toBe(true);
    const dir = temp();
    vi.stubEnv("MARKET_DATA_BASE_URL", ""); vi.stubEnv("VERCEL", ""); vi.stubEnv("MARKET_DATA_DIR", dir);
    writeCsvPanel(path.join(dir, "1h"), "CF", fullDay);
    writeCsvPanel(path.join(dir, "2h"), "CF", [{ ...fullDay[0], close: 999 }]);
    expect(Array.from((await loadMarketPanel("2h", "CF"))!.close)).toEqual([11.5, 13.5, 15.5, 16.5]);
  });
});

describe("旧 2H 全量替换", () => {
  it("处理全部现有股票，包括扩池，并覆盖同日期旧棒；重复重建结果一致", () => {
    const root = temp(), one = path.join(root, "1h"), two = path.join(root, "2h");
    for (const symbol of ["CF", "NVDA"]) writeCsvPanel(one, symbol, fullDay);
    writeCsvPanel(two, "CF", [{ ...fullDay[4], close: 999 }]);
    expect(rebuildTwoHourCsv(one, two).map((r) => r.ticker)).toEqual(["CF", "NVDA"]);
    const first = readFileSync(path.join(two, "CF.csv"), "utf8");
    expect(readCsvPanel(two, "CF")!.dates).toHaveLength(4);
    expect(Array.from(readCsvPanel(two, "CF")!.close)).toEqual([11.5, 13.5, 15.5, 16.5]);
    rebuildTwoHourCsv(one, two);
    expect(readFileSync(path.join(two, "CF.csv"), "utf8")).toBe(first);
    expect(readdirSync(root).sort()).toEqual(["1h", "2h"]);
  });

  it("任意所需股票缺 1H 时不发布半套新文件，4H 始终不动", () => {
    const root = temp(), one = path.join(root, "1h"), two = path.join(root, "2h"), four = path.join(root, "4h");
    mkdirSync(one);
    writeCsvPanel(two, "CF", fullDay.slice(0, 3));
    writeCsvPanel(four, "CF", fullDay.slice(0, 2));
    const old = readFileSync(path.join(two, "CF.csv"), "utf8"), old4 = readFileSync(path.join(four, "CF.csv"), "utf8");
    expect(() => rebuildTwoHourCsv(one, two)).toThrow("CF: 缺少 1H");
    expect(readFileSync(path.join(two, "CF.csv"), "utf8")).toBe(old);
    expect(readFileSync(path.join(four, "CF.csv"), "utf8")).toBe(old4);
    expect(readdirSync(root).sort()).toEqual(["1h", "2h", "4h"]);
  });
});
