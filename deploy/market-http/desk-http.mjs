import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = process.env.DESK_DIR || "/data";
const SECRET = (process.env.DESK_STORE_SECRET || "").trim();
const FILES = new Set(["lookback-snapshots.json", "book-epoch.json"]);
const EMPTY = {
  "lookback-snapshots.json": "[]\n",
  "book-epoch.json": "{}\n",
};
const MAX = 512 * 1024;

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
  if (!FILES.has(name)) {
    deny(res, 404, "not found");
    return;
  }
  const file = `${DIR}/${name}`;
  if (req.method === "GET") {
    const body = existsSync(file) ? readFileSync(file) : Buffer.from(EMPTY[name] ?? "{}\n");
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
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
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, raw.endsWith("\n") ? raw : `${raw}\n`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}\n');
    });
    return;
  }
  deny(res, 405, "method");
}).listen(8080, "0.0.0.0");
