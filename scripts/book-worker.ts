import { createServer, type IncomingMessage } from "node:http";

import { peekLiveBooks, refreshLiveBooks } from "@/lib/fund/liveBooks";

const PORT = Number(process.env.PORT || 8081);
const SECRET = (process.env.DESK_STORE_SECRET || process.env.CRON_SECRET || "").trim();

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(`${JSON.stringify(body)}\n`);
}

function local(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function authorized(req: IncomingMessage): boolean {
  if (!SECRET) return true;
  if (local(req)) return true;
  const got = req.headers.authorization ?? "";
  return got === `Bearer ${SECRET}` || got === SECRET;
}

function nameOf(url: string | undefined): string {
  return (url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
}

createServer((req, res) => {
  const name = nameOf(req.url);
  if (req.method === "GET" && (name === "/" || name === "/health")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }

  if (name === "/live-books" && req.method === "GET") {
    void peekLiveBooks()
      .then((cached) => json(res, 200, cached ?? { books: [] }))
      .catch((error: unknown) => {
        json(res, 500, { error: error instanceof Error ? error.message : "读取失败" });
      });
    return;
  }

  if (name === "/live-books" && req.method === "POST") {
    if (!authorized(req)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    void refreshLiveBooks()
      .then((result) => json(res, 200, { ok: true, ...result }))
      .catch((error: unknown) => {
        json(res, 500, { error: error instanceof Error ? error.message : "算账本失败" });
      });
    return;
  }

  json(res, 404, { error: "not found" });
}).listen(PORT, "0.0.0.0", () => {
  console.info(`[book-worker] :${PORT}`);
});
