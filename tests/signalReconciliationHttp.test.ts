import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

let dir: string, base: string, child: ChildProcessWithoutNullStreams;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "reconciliation-http-"));
  const signal = Date.parse("2026-09-28T17:30:00Z");
  const strategyKey = "aa-4h-v1|NASDAQ:CSCO|240|4|6|2.5|true|true|true|30|true|false";
  const id = createHash("sha256").update(JSON.stringify(["CSCO", "240", strategyKey, signal])).digest("hex");
  for (const [folder, event] of [["signal-entries", "buy"], ["signal-reviews", "sell"]]) {
    mkdirSync(path.join(dir, folder));
    writeFileSync(path.join(dir, folder, `${id}.json`), JSON.stringify({ version: 1, id, capturedAt: "2026-09-29T00:00:00.000Z", token: "private-top-level",
      payload: { event, symbol: "CSCO", tf: "240", kind: 2, strategyKey, price: 80, entrySignalTime: signal, barTime: signal, token: "private-payload",
        chart: { version: 1, stride: 1, bars: [[signal - 14_400_000, signal, 79, 81, 78, 80]] } } }));
  }
  child = spawn(process.execPath, [path.join(process.cwd(), "deploy/market-http/desk-http.mjs")], {
    env: { ...process.env, PORT: "0", DESK_BIND: "127.0.0.1", DESK_DIR: dir, DESK_STORE_SECRET: "test-secret" },
  });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout")), 5000);
    let output = "", stderr = "";
    child.stderr.on("data", data => { stderr += String(data); });
    child.stdout.on("data", data => {
      output += String(data); const match = /desk listening (\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`desk exited ${code}: ${stderr}`)); });
  });
});
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it("requires authentication, returns only compact evidence, and cannot write through the projection", async () => {
  const query = new URLSearchParams({ from: "2026-09-01T00:00:00Z", through: "2026-10-01T00:00:00Z", limit: "1" });
  const url = `${base}/signal-reconciliation-evidence.json?${query}`, headers = { authorization: "Bearer test-secret" };
  expect((await fetch(url)).status).toBe(401);
  const res = await fetch(url, { headers }); expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ invalid: 0, missing: 0, truncated: true, records: [{ payload: { kind: 2 }, signalBarOpenTime: Date.parse("2026-09-28T13:30:00Z") }] });
  expect(body.records).toHaveLength(1);
  expect(JSON.stringify(body)).not.toContain("private-");
  expect(JSON.stringify(body)).not.toContain("chart");
  expect((await fetch(url, { method: "PUT", headers, body: "{}" })).status).toBe(404);
  expect((await fetch(`${base}/signal-review-index.json`)).status).toBe(401);
  expect(await (await fetch(`${base}/signal-review-index.json`, { headers })).json()).toHaveLength(1);
  expect((await fetch(`${base}/signal-reconciliation-evidence.json?from=bad`, { headers })).status).toBe(400);
});


it("skips oversized old charts with partial coverage while retaining recent evidence", async () => {
  const signal = Date.parse("2020-01-01T17:30:00Z");
  const strategyKey = "aa-4h-v1|NASDAQ:CSCO|240|4|6|2.5|true|true|true|30|true|false";
  const id = createHash("sha256").update(JSON.stringify(["CSCO", "240", strategyKey, signal])).digest("hex");
  writeFileSync(path.join(dir, "signal-entries", `${id}.json`), JSON.stringify({ version: 1, id, capturedAt: "2020-01-01T18:00:00Z",
    payload: { event: "buy", symbol: "CSCO", tf: "240", strategyKey, price: 80, entrySignalTime: signal, barTime: signal }, chartPadding: "x".repeat(3 * 1024 * 1024) }));
  const query = new URLSearchParams({ from: "2026-09-01T00:00:00Z", through: "2026-10-01T00:00:00Z", limit: "400" });
  const body = await (await fetch(`${base}/signal-reconciliation-evidence.json?${query}`, { headers: { authorization: "Bearer test-secret" } })).json();
  expect(body).toMatchObject({ invalid: 0, missing: 0, truncated: true });
  expect(body.records).toHaveLength(2);
  expect((await fetch(`${base}/health`)).status).toBe(200);
});
