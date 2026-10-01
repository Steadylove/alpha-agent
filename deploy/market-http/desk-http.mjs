import { createServer } from "node:http";
import { existsSync, mkdirSync, opendirSync, readFileSync, readdirSync, statSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const DIR = process.env.DESK_DIR || "/data";
const SECRET = (process.env.DESK_STORE_SECRET || "").trim();
const FILES = new Set(["lookback-snapshots.json", "book-epoch.json", "signal-pool.json", "live-books.json", "option-flow.json", "option-flow-health.json", "push-routes.json"]);
const EMPTY = {
  "lookback-snapshots.json": "[]\n",
  "book-epoch.json": "{}\n",
  "signal-pool.json": "{}\n",
  "live-books.json": "{}\n",
  "option-flow.json": "{\"updatedAt\":\"\",\"channelId\":\"\",\"lastMessageId\":\"\",\"posts\":[]}\n",
  "push-routes.json": "{}\n",
  "option-flow-health.json": "null\n",
};
const MAX = 8 * 1024 * 1024;
// Same limits as signalReconciliationStore.ts; bound disk work, not just response size.
const RECONCILIATION_SCAN = { metadata: 2048, files: 512, bytes: 16 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, ms: 1000 };
const VERSION = /^book-versions\/([a-zA-Z0-9-]{1,80})\.json$/;
const SIGNAL = /^signal-(entries|reviews)\/([a-f0-9]{64})\.json$/;

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
  const { signalReconciliation: _report, ...summary } = b;
  return {
    ...summary, id,
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
  if (req.method === "GET" && ["signal-entry-index.json", "signal-review-index.json"].includes(name)) {
    if (!authorized(req) || (name === "signal-review-index.json" && !SECRET)) { deny(res, 401, "unauthorized"); return; }
    try {
      const dir = `${DIR}/${name === "signal-entry-index.json" ? "signal-entries" : "signal-reviews"}`;
      const ids = existsSync(dir) ? readdirSync(dir).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => f.slice(0, -5)).sort() : [];
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(ids));
    } catch { deny(res, 500, "cannot read signal index"); }
    return;
  }
  // A bounded, read-only projection: charts, account settings and notification credentials never leave this endpoint.
  if (req.method === "GET" && name === "signal-reconciliation-evidence.json") {
    if (!SECRET || !authorized(req)) { deny(res, 401, "unauthorized"); return; }
    const query = new URL(req.url, "http://desk").searchParams;
    const from = Date.parse(query.get("from") ?? ""), through = Date.parse(query.get("through") ?? "");
    const symbols = (query.get("symbols") ?? "").split(",").filter(Boolean);
    const limit = Number(query.get("limit") ?? 400);
    if (!Number.isFinite(from) || !Number.isFinite(through) || from > through || symbols.length > 80 ||
        symbols.some(s => !/^[A-Z][A-Z0-9.-]{0,15}$/.test(s)) || !Number.isInteger(limit) || limit < 1 || limit > 400) {
      deny(res, 400, "invalid reconciliation window"); return;
    }
    try {
      const records = [], candidates = []; let invalid = 0, missing = 0, truncated = false;
      const startedAt = Date.now(); let inspected = 0, reads = 0, bytes = 0;
      for (const [folder, event] of [["signal-entries", "buy"], ["signal-reviews", "sell"]]) {
        const dir = `${DIR}/${folder}`;
        if (!existsSync(dir)) { missing++; continue; }
        const handle = opendirSync(dir);
        try {
          for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
            if (++inspected > RECONCILIATION_SCAN.metadata || Date.now() - startedAt >= RECONCILIATION_SCAN.ms) { truncated = true; break; }
            if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
            try {
              const file = `${dir}/${entry.name}`, stat = statSync(file);
              candidates.push({ file, id: entry.name.slice(0, -5), event, size: stat.size, modified: stat.mtimeMs });
            } catch { invalid++; }
          }
        } finally { handle.closeSync(); }
      }
      candidates.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
      for (const candidate of candidates) {
        if (reads >= RECONCILIATION_SCAN.files || Date.now() - startedAt >= RECONCILIATION_SCAN.ms) { truncated = true; break; }
        if (candidate.size > RECONCILIATION_SCAN.fileBytes || bytes + candidate.size > RECONCILIATION_SCAN.bytes) { truncated = true; continue; }
        reads++; bytes += candidate.size;
        const { event } = candidate;
        try {
            const row = JSON.parse(readFileSync(candidate.file, "utf8")), p = row?.payload;
            if (row?.version !== 1 || row.id !== candidate.id || p?.event !== event || typeof p.symbol !== "string" || typeof p.tf !== "string" ||
                typeof p.strategyKey !== "string" || !p.strategyKey || p.strategyKey.length > 512 || !Number.isSafeInteger(p.barTime) || p.barTime <= 0 || p.barTime > 8.64e15 ||
                !Number.isSafeInteger(p.entrySignalTime) || p.entrySignalTime <= 0 || p.entrySignalTime > p.barTime || (event === "buy" && p.entrySignalTime !== p.barTime) ||
                (p.kind !== undefined && p.kind !== 1 && p.kind !== 2) || !Number.isFinite(p.price) || p.price <= 0 || !Number.isFinite(Date.parse(row.capturedAt))) { invalid++; continue; }
            const id = createHash("sha256").update(JSON.stringify([p.symbol.toUpperCase(), p.tf, p.strategyKey, p.entrySignalTime])).digest("hex");
            if (id !== row.id) { invalid++; continue; }
            const symbol = p.symbol.trim().toUpperCase().replace(/^.*:/, "");
            if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol) || !["120", "240", "2H", "4H"].includes(p.tf.toUpperCase())) { invalid++; continue; }
            if (p.barTime > through || (p.barTime < from && !symbols.includes(symbol))) continue;
            const payload = Object.fromEntries(["event", "symbol", "tf", "strategyKey", "barTime", "entrySignalTime", "price", "kind"]
              .filter(key => p[key] !== undefined).map(key => [key, p[key]]));
            if (Number.isFinite(p.entry) && p.entry > 0) payload.entry = p.entry;
            if (Number.isSafeInteger(p.entryTime) && p.entryTime > 0 && p.entryTime <= 8.64e15) payload.entryTime = p.entryTime;
            const barOpen = close => {
              if (p.chart?.version !== 1 || p.chart.stride !== 1 || !Array.isArray(p.chart.bars)) return undefined;
              const bar = p.chart.bars.find(b => Array.isArray(b) && b.length >= 6 && Number.isSafeInteger(b[0]) && b[0] > 0 && b[0] < close && b[1] === close);
              return bar?.[0];
            };
            const projected = { version: 1, id, capturedAt: row.capturedAt, payload,
              signalBarOpenTime: barOpen(p.barTime), entrySignalBarOpenTime: barOpen(p.entrySignalTime) };
            const before = records.findIndex(r => r.payload.barTime < p.barTime || (r.payload.barTime === p.barTime && r.id > id));
            records.splice(before < 0 ? records.length : before, 0, projected);
            if (records.length > limit) { records.pop(); truncated = true; }
        } catch { invalid++; }
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ records, invalid, missing, truncated }));
    } catch { deny(res, 500, "cannot read reconciliation evidence"); }
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
  const signal = SIGNAL.exec(name);
  if (!FILES.has(name) && !signal) {
    deny(res, 404, "not found");
    return;
  }
  const file = `${DIR}/${name}`;
  if (signal && !authorized(req)) {
    deny(res, 401, "unauthorized");
    return;
  }
  if (req.method === "GET") {
    try {
      const body = existsSync(file) ? readFileSync(file) : Buffer.from(signal ? "null\n" : EMPTY[name] ?? "{}\n");
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
        if (signal) {
          const next = JSON.parse(raw);
          const p = next?.payload;
          const expected = p && createHash("sha256").update(JSON.stringify([p.symbol?.toUpperCase(), p.tf, p.strategyKey, p.entrySignalTime])).digest("hex");
          if (next?.version !== 1 || next?.id !== signal[2] || next.id !== expected ||
              p?.event !== (signal[1] === "entries" ? "buy" : "sell") || !Number.isSafeInteger(p.entrySignalTime) ||
              !p.strategyKey || !next.capturedAt || (signal[1] === "entries" ? !next.quality : !next.assessment)) {
            deny(res, 400, "invalid signal snapshot");
            return;
          }
          if (existsSync(file)) {
            if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== JSON.stringify(next)) {
              deny(res, 409, "signal snapshot is immutable");
              return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"ok":true}\n');
            return;
          }
        }
        if (name === "book-epoch.json") {
          const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
          const next = JSON.parse(raw);
          if (req.headers["if-match"] !== JSON.stringify(previous.updatedAt || "")) {
            deny(res, 409, "记账起点已被其他操作更新，请刷新后重试");
            return;
          }
          if (!next?.updatedAt || !Number.isFinite(Date.parse(next.updatedAt)) || next.updatedAt === previous.updatedAt ||
            ["4h", "2h"].some((tf) => !/^\d{4}-\d{2}-\d{2}$/.test(next.epochs?.[tf]?.from || "") || typeof next.epochs?.[tf]?.resetAt !== "string")) {
            deny(res, 400, "请使用分周期记账起点配置");
            return;
          }
        }
        if (name === "signal-pool.json") {
          const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
          const next = JSON.parse(raw);
          if (req.headers["if-match"] != null && req.headers["if-match"] !== JSON.stringify(previous.updatedAt || "")) {
            deny(res, 409, "股票池已被其他操作更新，请刷新后重试");
            return;
          }
          if (previous.revisions && (req.headers["if-match"] == null || !Array.isArray(next.revisions) ||
            next.revisions.length !== previous.revisions.length + 1 ||
            JSON.stringify(next.revisions.slice(0, -1)) !== JSON.stringify(previous.revisions))) {
            deny(res, 409, "不能覆盖股票池历史版本，请刷新后重试");
            return;
          }
        }
        if (name === "live-books.json") {
          const book = JSON.parse(raw);
          if (!book.runId || !book.computedAt || !Array.isArray(book.books) || book.books.length !== 2) {
            deny(res, 400, "invalid live books");
            return;
          }
          const epochFile = `${DIR}/book-epoch.json`;
          const config = existsSync(epochFile) ? JSON.parse(readFileSync(epochFile, "utf8")) : {};
          if (config.epochs && ["4h", "2h"].some((tf) =>
            book.epochs?.[tf]?.from !== config.epochs[tf]?.from || book.epochs?.[tf]?.resetAt !== config.epochs[tf]?.resetAt ||
            book.books.find((b) => b.tf === tf)?.view?.since !== config.epochs[tf]?.from)) {
            deny(res, 409, "账本与分周期记账起点不一致，请更新计算程序后重试");
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
