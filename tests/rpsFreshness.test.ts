import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { freshAlertRps, previousRpsSession, type RpsSnapshot } from "@/lib/backtest/rpsSnapshot";

const snapshot = (): RpsSnapshot => ({ generatedAt: "2026-09-18T00:45:00Z", poolId: "sf-broad", sourceTimeframe: "1d", benchmark: "SP500",
  calendar: { from: "2026-09-01", through: "2026-10-01", sessions: ["2026-09-03", "2026-09-04", "2026-09-08", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21"] },
  timeframes: { "1d": { MSFT: { rps: 72.82, asOf: "2026-09-17" } } } });
const signal = new Date("2026-09-18T15:30:00Z");

describe("告警 RPS 时点", () => {
  it("2H/4H均取前一交易日日线，并返回可追溯来源", () => {
    for (const tf of ["2h", "4h"] as const) expect(freshAlertRps(snapshot(), "BATS:MSFT", tf, signal)).toMatchObject({ rps: 72.82, asOf: "2026-09-17", sourceTimeframe: "1d", generatedAt: "2026-09-18T00:45:00Z" });
  });
  it("拒绝9月4日旧值、当天收盘值及事后生成的历史排名", () => {
    for (const day of ["2026-09-04", "2026-09-18"]) { const s = snapshot(); s.timeframes['1d']!.MSFT.asOf = day; expect(() => freshAlertRps(s,"MSFT","2h",signal)).toThrow(/过期或超前/); }
    expect(() => freshAlertRps(snapshot(),"MSFT","2h",new Date("2026-09-17T15:30:00Z"))).toThrow(/之后生成/);
  });
  it("处理劳动节、周末和日历过期；不能把无日期的旧格式当成有效数据", () => {
    expect(previousRpsSession(snapshot().calendar,"2026-09-08")).toBe("2026-09-04");
    expect(previousRpsSession(snapshot().calendar,"2026-09-21")).toBe("2026-09-18");
    expect(() => previousRpsSession(snapshot().calendar,"2026-10-02")).toThrow(/过期/);
    expect(() => freshAlertRps({...snapshot(), sourceTimeframe:undefined},"MSFT","4h",signal)).toThrow(/旧版/);
  });
  it("股票没有当日排名就不回填；无效数值不能通过筛选", () => {
    expect(freshAlertRps(snapshot(),"HALTED","4h",signal)).toBeNull();
    for (const rps of [NaN, Infinity, 0, 100]) { const s=snapshot();s.timeframes['1d']!.MSFT.rps=rps;expect(()=>freshAlertRps(s,"MSFT","4h",signal)).toThrow(/无效/); }
  });
});

describe("快照缓存刷新", () => {
  let dir: string;
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(signal);
    dir=mkdtempSync(path.join(tmpdir(),"rps-cache-"));mkdirSync(path.join(dir,"rps"));
    vi.stubEnv("VERCEL","");vi.stubEnv("MARKET_DATA_BASE_URL","");vi.stubEnv("MARKET_DATA_DIR",dir);
    writeFileSync(path.join(dir,"rps/rps-latest.json"),JSON.stringify(snapshot()));
  });
  afterEach(() => {vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});});
  it("远程配置优先于本地旧快照，60秒后更新且合并并发读取",async()=>{
    vi.stubEnv("MARKET_DATA_BASE_URL","https://market.test");
    const first=snapshot(),second=snapshot();first.timeframes['1d']!.MSFT.rps=10;second.timeframes['1d']!.MSFT.rps=90;
    const fetch=vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(second));vi.stubGlobal("fetch",fetch);
    const mod=await import("@/lib/backtest/rpsSnapshot");
    expect(mod.readRpsSnapshot()).toBeNull();
    await Promise.all([mod.ensureRpsSnapshot(),mod.ensureRpsSnapshot()]);expect(fetch).toHaveBeenCalledTimes(1);
    expect(mod.lookupAlertRps("MSFT","2h",signal)?.rps).toBe(10);
    vi.setSystemTime(signal.getTime()+60001);await mod.ensureRpsSnapshot();expect(fetch).toHaveBeenCalledTimes(2);
    expect(mod.lookupAlertRps("MSFT","2h",signal)?.rps).toBe(90);
  });
  it("刷新失败后不能继续使用过期缓存或回退本地文件",async()=>{
    vi.stubEnv("MARKET_DATA_BASE_URL","https://market.test");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json(snapshot())).mockRejectedValue(new Error("offline")));
    const mod=await import("@/lib/backtest/rpsSnapshot");await mod.ensureRpsSnapshot();vi.setSystemTime(signal.getTime()+60001);
    await expect(mod.ensureRpsSnapshot()).rejects.toThrow("offline");expect(mod.readRpsSnapshot()).toBeNull();
  });
  it("本地文件替换后不永远使用旧内容",async()=>{
    const mod=await import("@/lib/backtest/rpsSnapshot");await mod.ensureRpsSnapshot();const s=snapshot();s.timeframes['1d']!.MSFT.rps=99;
    writeFileSync(path.join(dir,"rps/rps-latest.json"),JSON.stringify(s));vi.setSystemTime(signal.getTime()+60001);
    expect((await mod.ensureRpsSnapshot())?.timeframes['1d']!.MSFT.rps).toBe(99);
  });
});
