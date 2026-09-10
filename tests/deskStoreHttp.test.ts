import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bookCache } from "./liveBooksFixtures";

let dir: string;
let child: ChildProcessWithoutNullStreams;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "desk-http-"));
  child = spawn(process.execPath, [path.join(process.cwd(), "deploy/market-http/desk-http.mjs")], {
    env: { ...process.env, PORT: "0", DESK_BIND: "127.0.0.1", DESK_DIR: dir, DESK_STORE_SECRET: "test-secret" },
  });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("desk startup timeout")), 5000);
    let output = "";
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.stdout.on("data", (data) => {
      output += data.toString();
      const match = /desk listening (\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`desk exited ${code}: ${stderr}`)); });
  });
});
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill(); await done; }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it("VPS 文件服务保存并归档，失败不会冒充成功或损坏当前结果", async () => {
  const put = (book: unknown) => fetch(`${base}/live-books.json`, {
    method: "PUT", headers: { authorization: "Bearer test-secret", "content-type": "application/json" }, body: JSON.stringify(book),
  });
  const first = bookCache();
  const second = bookCache({ runId: "second-run", computedAt: "2026-09-10T00:00:00Z", poolKey: "NVDA" });
  expect((await put(first)).status).toBe(200);
  expect((await put(second)).status).toBe(200);
  const history = await (await fetch(`${base}/live-books-history.json`)).json();
  expect(history.map((v: { id: string }) => v.id)).toEqual(["second-run", "test-run-1"]);
  expect(await (await fetch(`${base}/book-versions/test-run-1.json`)).json()).toEqual(first);
  expect((await put({ ...second, poolKey: "MSFT" })).status).toBe(500);
  expect((await put({ books: [] })).status).toBe(400);
  expect(JSON.parse(readFileSync(path.join(dir, "live-books.json"), "utf8"))).toEqual(second);
  const unauthorized = await fetch(`${base}/live-books.json`, { method: "PUT", body: JSON.stringify(first) });
  expect(unauthorized.status).toBe(401);
  expect((await fetch(`${base}/book-versions/test-run-1.json`, { method: "PUT", body: "{}" })).status).toBe(404);
});

it("并发保存股票池时只接受基于最新版本的请求，历史不能被覆盖", async () => {
  const put = (value: unknown, expected?: string) => fetch(`${base}/signal-pool.json`, {
    method: "PUT", headers: { authorization: "Bearer test-secret", "content-type": "application/json", ...(expected != null ? { "if-match": JSON.stringify(expected) } : {}) },
    body: JSON.stringify(value),
  });
  const initial = { members: ["AAPL"], updatedAt: "2026-09-09T00:00:00Z", revisions: [{ id: "base", effectiveAt: "", members: ["AAPL"] }] };
  expect((await put(initial, "")).status).toBe(200);
  const next = (id: string) => ({ members: [id], updatedAt: "2026-09-10T00:00:00Z", revisions: [...initial.revisions, { id, effectiveAt: "2026-09-10T00:00:00Z", members: [id] }] });
  const responses = await Promise.all([put(next("NVDA"), initial.updatedAt), put(next("MSFT"), initial.updatedAt)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await put({ members: ["GOOG"] })).status).toBe(409);
  const stored = await (await fetch(`${base}/signal-pool.json`)).json();
  expect(stored.revisions).toHaveLength(2);
  expect(stored.revisions[0]).toEqual(initial.revisions[0]);
});

it("分周期起点并发保存不丢另一周期的修改，旧计算程序不能覆盖新起点的账本", async () => {
  const put = (name: string, value: unknown, expected?: string) => fetch(`${base}/${name}`, {
    method: "PUT", headers: { authorization: "Bearer test-secret", "content-type": "application/json",
      ...(expected != null ? { "if-match": JSON.stringify(expected) } : {}) }, body: JSON.stringify(value),
  });
  const epoch = { from: "2026-01-01", resetAt: "" };
  const initial = { ...epoch, epochs: { "4h": epoch, "2h": epoch }, updatedAt: "2026-09-10T00:00:00.000Z" };
  expect((await put("book-epoch.json", initial, "")).status).toBe(200);
  const updates = (["4h", "2h"] as const).map((tf) => ({ ...initial, epochs: { ...initial.epochs,
    [tf]: { from: "2026-08-01", resetAt: "2026-09-10T00:01:00.000Z" } }, updatedAt: "2026-09-10T00:01:00.000Z" }));
  const responses = await Promise.all(updates.map((next) => put("book-epoch.json", next, initial.updatedAt)));
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await put("book-epoch.json", { from: "2025-01-01" })).status).toBe(409);
  const stored = await (await fetch(`${base}/book-epoch.json`)).json();
  expect(stored).toEqual(updates[responses.findIndex((r) => r.status === 200)]);
  const before = readFileSync(path.join(dir, "live-books.json"), "utf8");
  expect((await put("live-books.json", bookCache({ runId: "outdated-worker" }))).status).toBe(409);
  expect(readFileSync(path.join(dir, "live-books.json"), "utf8")).toBe(before);
  const next = bookCache({ runId: "separate-worker", epochFrom: stored.epochs["4h"].from, epochs: stored.epochs });
  next.books = next.books.map((b) => ({ ...b, view: { ...b.view, since: stored.epochs[b.tf].from } }));
  expect((await put("live-books.json", next)).status).toBe(200);
  const versions = await (await fetch(`${base}/live-books-history.json`)).json();
  expect(versions.find((v: { id: string }) => v.id === next.runId).epochs).toEqual(stored.epochs);
});
