import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const DIR = process.env.DESK_DIR || "/data";
const SECRET = (process.env.DESK_STORE_SECRET || "").trim();
const FILES = new Set(["lookback-snapshots.json", "book-epoch.json", "signal-pool.json", "live-books.json"]);
const EMPTY = {
  "lookback-snapshots.json": "[]\n",
  "book-epoch.json": "{}\n",
  "signal-pool.json": "{}\n",
  "live-books.json": "{}\n",
};
const MAX = 8 * 1024 * 1024;
const VERSION = /^book-versions\/([a-zA-Z0-9-]{1,80})\.json$/;

function atomic(file, raw) {
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, raw, { flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function versionId(book) {
  return book.runId || `legacy-${createHash("sha256").update(JSON.stringify([book.computedAt, book.epochFrom, book.poolKey, book.slots])).digest("hex").slice(0, 32)}`;
}

function archive(book) {
  if (!book?.computedAt || !Array.isArray(book.books)) return;
  const id = versionId(book);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("invalid version id");
  const file = `${DIR}/book-versions/${id}.json`;
  if (existsSync(file)) {
    if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== JSON.stringify(book)) throw new Error("version already exists");
    return;
  }
  atomic(file, `${JSON.stringify(book)}\n`);
}

function versionSummary(b, id) {
  return {
    ...b, id,
    books: b.books.map(({ tf, view: v }) => ({ tf, pnl: v.pnl, equity: v.equity, dd: v.stats.dd, holdings: v.rows.length, asOf: v.asOf })),
  };
}

function history() {
  const dir = `${DIR}/book-versions`;
  const all = new Map();
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => /^[a-zA-Z0-9-]{1,80}\.json$/.test(f))) {
      const book = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
      all.set(file.slice(0, -5), versionSummary(book, file.slice(0, -5)));
    }
  }
  if (existsSync(`${DIR}/live-books.json`)) {
    const current = JSON.parse(readFileSync(`${DIR}/live-books.json`, "utf8"));
    if (current?.computedAt) all.set(versionId(current), versionSummary(current, versionId(current)));
  }
  return [...all.values()].sort((a, b) => b.computedAt.localeCompare(a.computedAt));
}

function deny(res, code, msg) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(`${JSON.stringify({ error: msg })}\n`);
}

function nameOf(url) {
  return (url ?? "/").split("?")[0].replace(/^\/+/, "");
}

function authorized(req) {
  if (!SECRET) return true;
  const got = req.headers.authorization ?? req.headers["x-desk-secret"] ?? "";
  return got === `Bearer ${SECRET}` || got === SECRET;
}

createServer((req, res) => {
  const name = nameOf(req.url);
  if (req.method === "GET" && (name === "" || name === "health")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }
  if (req.method === "GET" && name === "live-books-history.json") {
    try {
      const body = JSON.stringify(history());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    } catch { deny(res, 500, "cannot read book history"); }
    return;
  }
  const version = VERSION.exec(name);
  if (req.method === "GET" && version) {
    const archived = `${DIR}/${name}`;
    try {
      let body = existsSync(archived) ? readFileSync(archived) : null;
      if (!body && existsSync(`${DIR}/live-books.json`)) {
        const current = JSON.parse(readFileSync(`${DIR}/live-books.json`, "utf8"));
        if (versionId(current) === version[1]) body = Buffer.from(JSON.stringify(current));
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body ?? "null");
    } catch { deny(res, 500, "cannot read book version"); }
    return;
  }
  if (!FILES.has(name)) {
    deny(res, 404, "not found");
    return;
  }
  const file = `${DIR}/${name}`;
  if (req.method === "GET") {
    try {
      const body = existsSync(file) ? readFileSync(file) : Buffer.from(EMPTY[name] ?? "{}\n");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    } catch { deny(res, 500, "cannot read desk data"); }
    return;
  }
  if (req.method === "PUT") {
    if (!authorized(req)) {
      deny(res, 401, "unauthorized");
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        tooBig = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      if (tooBig) {
        deny(res, 413, "too large");
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        JSON.parse(raw);
      } catch {
        deny(res, 400, "invalid json");
        return;
      }
      try {
        if (name === "live-books.json") {
          const book = JSON.parse(raw);
          if (!book.runId || !book.computedAt || !Array.isArray(book.books) || book.books.length !== 2) {
            deny(res, 400, "invalid live books");
            return;
          }
          if (existsSync(file)) archive(JSON.parse(readFileSync(file, "utf8")));
          archive(book);
        }
        atomic(file, raw.endsWith("\n") ? raw : `${raw}\n`);
      } catch (error) {
        console.error("desk write failed", error);
        deny(res, 500, "保存失败，原账本未替换");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}\n');
    });
    return;
  }
  deny(res, 405, "method");
}).listen(Number(process.env.PORT || 8080), process.env.DESK_BIND || "0.0.0.0", function () {
  console.info(`desk listening ${this.address().port}`);
});
