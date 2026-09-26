import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("deploy/market-http/cron/alpha-catalyst.sh");
const dirs: string[] = [];
function setup(lockBusy = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "catalyst-cron-")); dirs.push(root);
  for (const dir of ["bin", "repo", "market-http"]) mkdirSync(path.join(root, dir));
  writeFileSync(path.join(root, "daily-quant.env"), 'VERCEL=1\nMARKET_DATA_BASE_URL="https://remote.invalid"\nMARKET_DATA_DIR="/wrong"\nSIGNAL_JOURNAL_DIR="/wrong"\nLIVE_BOOKS_PATH="/wrong/live-books.json"\n');
  writeFileSync(path.join(root, "bin/flock"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$ALPHA_ROOT/flock-args.txt"\nexit ${lockBusy ? 1 : 0}\n`);
  chmodSync(path.join(root, "bin/flock"), 0o755);
  writeFileSync(path.join(root, "market-http/catalyst.mjs"), `import fs from 'node:fs'; fs.writeFileSync(process.env.ALPHA_ROOT+'/called.json',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),market:process.env.MARKET_DATA_DIR,journal:process.env.SIGNAL_JOURNAL_DIR,books:process.env.LIVE_BOOKS_PATH,base:process.env.MARKET_DATA_BASE_URL,vercel:process.env.VERCEL??null,tz:process.env.TZ}));`);
  const run = (args: string[] = []) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ALPHA_ROOT: root, PATH: `${path.join(root, "bin")}:${process.env.PATH}` } });
  return { root, run };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("independent Catalyst cron", () => {
  it("schedules collection at :07/:37 with time to finish before existing :30 jobs", () => {
    const folder = path.resolve("deploy/market-http/cron");
    const timer = readFileSync(path.join(folder, "alpha-catalyst.timer"), "utf8");
    expect(timer).toContain("OnCalendar=*-*-* *:07,37:00 Asia/Shanghai");
    const minutes = timer.match(/OnCalendar=\*-\*-\* \*:(\d{2}),(\d{2}):00/)!.slice(1).map(Number);
    const timeoutSeconds = Number(readFileSync(path.join(folder, "alpha-catalyst.service"), "utf8").match(/^TimeoutStartSec=(\d+)$/m)![1]);
    for (const original of ["alpha-daily-quant.timer", "alpha-review-macro.timer"]) {
      const protectedMinute = Number(readFileSync(path.join(folder, original), "utf8").match(/OnCalendar=.* \d{2}:(\d{2}):00/)![1]);
      for (const minute of minutes) expect((protectedMinute - minute + 60) % 60).toBeGreaterThan(timeoutSeconds / 60 + 1);
    }
    const analysis = readFileSync(path.join(folder, "alpha-catalyst-analysis.timer"), "utf8");
    expect(analysis).toContain("OnCalendar=Tue..Sat *-*-* 10:05:00 Asia/Shanghai");
    expect(analysis).toContain("OnCalendar=*-*-* 12:55:00 Asia/Shanghai");
    expect(analysis).toContain("OnCalendar=Mon..Fri *-*-* 08:55:00 America/New_York");
    expect(analysis).not.toContain("08:55:00 Asia/Shanghai");
    expect(readFileSync(path.join(folder, "alpha-catalyst.service"), "utf8")).not.toContain("Restart=");
  });
  it("runs only the isolated bundle with deployed market, journal and live-book paths", () => {
    const { root, run } = setup(); const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, "called.json"), "utf8"))).toEqual({ args: [], cwd: realpathSync(`${root}/repo`), market: `${root}/market`, journal: `${root}/desk`, books: `${root}/desk/live-books.json`, base: "", vercel: null, tz: "Asia/Shanghai" });
    expect(readFileSync(path.join(root, "flock-args.txt"), "utf8").trim()).toBe("-n 9");
    expect(existsSync(path.join(root, "daily-quant.lock"))).toBe(true);
  });
  it("skips collection while the daily data writer holds the shared lock", () => {
    const { root, run } = setup(true); const result = run();
    expect(result.status).toBe(0); expect(existsSync(path.join(root, "called.json"))).toBe(false);
    expect(result.stdout).toContain("本轮采集跳过");
  });
  it("waits for the shared lock before analysis, passes --analyze and fails visibly on wait expiry", () => {
    const normal = setup(); expect(normal.run(["--analyze"]).status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(normal.root, "called.json"), "utf8")).args).toEqual(["--analyze"]);
    expect(readFileSync(path.join(normal.root, "flock-args.txt"), "utf8").trim()).toBe("-w 1800 9");
    const busy = setup(true); const failed = busy.run(["--analyze"]);
    expect(failed.status).toBe(1); expect(existsSync(path.join(busy.root, "called.json"))).toBe(false);
    expect(failed.stderr).toContain("未生成新分析");
  });
  it("passes explicit digest refresh only for requested runs", () => {
    const { root, run } = setup();
    expect(run(["--analyze", "--refresh-review-digest"]).status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, "called.json"), "utf8")).args).toEqual(["--analyze", "--refresh-review-digest"]);
    expect(readFileSync(path.join(root, "flock-args.txt"), "utf8").trim()).toBe("-w 1800 9");
    expect(run(["--refresh-review-digest"]).status).toBe(0);
    expect(readFileSync(path.join(root, "flock-args.txt"), "utf8").trim()).toBe("-n 9");
  });
  it("bounds paid-analysis failure retries while keeping enough interval for the next scheduled run", () => {
    const service = readFileSync(path.resolve("deploy/market-http/cron/alpha-catalyst-analysis.service"), "utf8");
    expect(service).toContain("--analyze --refresh-review-digest");
    expect(service).toContain("Restart=on-failure"); expect(service).toContain("RestartSec=300");
    expect(service).toContain("StartLimitBurst=2"); expect(service).toContain("StartLimitIntervalSec=7200");
    const timeout = Number(service.match(/^TimeoutStartSec=(\d+)$/m)![1]);
    expect(2 * (timeout + 300)).toBeLessThan(7200);
    expect(7200).toBeLessThan((12 * 60 + 55 - (10 * 60 + 5)) * 60);
    const installer = readFileSync(path.resolve("deploy/market-http/cron/install-catalyst.sh"), "utf8");
    expect(installer).toContain("systemctl restart alpha-catalyst.timer alpha-catalyst-analysis.timer");
  });
  it("rejects unsupported arguments before creating or calling anything", () => {
    const { root, run } = setup();
    expect(run(["--send"]).status).toBe(2);
    expect(existsSync(path.join(root, "called.json"))).toBe(false);
    expect(existsSync(path.join(root, "flock-args.txt"))).toBe(false);
  });
});
