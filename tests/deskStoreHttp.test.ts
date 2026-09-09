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
