import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { gexPushBody, type GexSnapshot } from "../src/lib/discord/gexCopy";

const DEFAULT_BOOK_PUSH = "https://alpha-agent-eight.vercel.app/api/jobs/push-signal-book";

function renderUrl(): string {
  if (process.env.GEX_PUSH_URL) return process.env.GEX_PUSH_URL;
  return new URL("/api/tv/render-gex", process.env.BOOK_PUSH_URL || DEFAULT_BOOK_PUSH).href;
}

async function main() {
  const file = resolve(process.argv[2] ?? ".cache/gex/latest.json");
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as GexSnapshot;
  if (!snapshot.items?.length) throw new Error(`${file} 没有 items`);
  const dest = renderUrl();
  const res = await fetch(dest, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(gexPushBody(snapshot, process.env.GEX_TEST === "1")),
  });
  if (!res.ok) {
    throw new Error((await res.text()).trim() || `GEX 出图失败 HTTP ${res.status}`);
  }
  console.log("pushed", dest, snapshot.items.map((row) => row.symbol).join(" "));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
