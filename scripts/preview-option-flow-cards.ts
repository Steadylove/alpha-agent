import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  renderNoteworthyPng,
  renderSessionDigestPng,
  renderSingleFlowPng,
} from "@/lib/optionFlow/cardImage";
import { readOptionFlow } from "@/lib/optionFlow/store";
import type { OptionFlowLeg, OptionFlowPost } from "@/lib/optionFlow/types";

const OUT = path.join(/*turbopackIgnore: true*/ process.cwd(), ".tmp", "option-flow-preview");

function pick(posts: OptionFlowPost[], test: (post: OptionFlowPost) => boolean): OptionFlowPost {
  const post = posts.find(test);
  if (!post) throw new Error("缺少样例帖，先跑 npm run option-flow:ingest");
  return post;
}

function digestLegs(posts: OptionFlowPost[]): OptionFlowLeg[] {
  const day = posts.filter((p) => p.postedAt.startsWith("2026-09-09") && p.kind === "flow" && p.legs[0]?.premiumUsd);
  const seen = new Set<string>();
  const legs: OptionFlowLeg[] = [];
  for (const post of day.sort((a, b) => (b.legs[0]?.premiumUsd ?? 0) - (a.legs[0]?.premiumUsd ?? 0))) {
    const leg = post.legs[0];
    if (!leg || seen.has(leg.ticker)) continue;
    seen.add(leg.ticker);
    legs.push(leg);
    if (legs.length >= 8) break;
  }
  return legs;
}

async function main() {
  const { posts } = await readOptionFlow();
  mkdirSync(OUT, { recursive: true });
  const call = pick(posts, (p) => p.kind === "flow" && p.legs[0]?.ticker === "PLTR" && p.legs[0]?.right === "call");
  const put = pick(posts, (p) => p.kind === "flow" && p.legs[0]?.ticker === "LYFT" && p.legs[0]?.right === "put");
  const strike = pick(posts, (p) => p.kind === "flow" && p.legs[0]?.strike != null);
  const list = pick(posts, (p) => p.kind === "noteworthy" && p.legs.length >= 3);
  const files = [
    ["1-single-call.png", await renderSingleFlowPng(call)],
    ["2-single-put.png", await renderSingleFlowPng(put)],
    ["3-single-strike.png", await renderSingleFlowPng(strike)],
    ["4-noteworthy.png", await renderNoteworthyPng(list)],
    ["5-session-digest.png", await renderSessionDigestPng("期权流 · 9月9日精选", "2026-09-09", digestLegs(posts))],
  ] as const;
  for (const [name, bytes] of files) {
    const file = path.join(OUT, name);
    writeFileSync(file, bytes);
    console.log(file, bytes.length);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
